// Claude Code Worker: MCP server (stdio) that gives the boss session (Claude Code CLI or Desktop) native tools for cc-bridge runs,
// the claude CLI's mcp/plugin subcommands, and settings.json files.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { validName, readSession, removeSession, sessionDir, pidAlive } from './lib/session.mjs'
import { call, listSessions, waitFor, NotRunning, WORKING, REPORT } from './lib/client.mjs'
import { KEYS } from './lib/keys.mjs'
import { resolveCommand, childEnv } from './lib/command.mjs'
import { waitAny } from './lib/events.mjs'
import { loadRoles } from './lib/roles.mjs'
import { createWorktree, listWorktrees, removeWorktree } from './lib/worktree.mjs'
import { loadQueue, saveQueue, addTasks, tick, FINAL } from './lib/queue.mjs'
import { startAsk, readAsk, waitAsk } from './lib/ask.mjs'
import { cleanup, doctor } from './lib/maint.mjs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const bridgeScript = path.join(dir, 'cc-bridge.mjs')
const ctlScript = path.join(dir, 'cc-ctl.mjs')
const reportsDir = path.join(sessionDir, 'reports')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Appended to every claude worker's system prompt so it does not follow the orchestrator rules in
// the global CLAUDE.md (and start workers of its own).
const WORKER_PROMPT = 'You are a Claude Code Worker run (cc-bridge), started and driven by a boss session (Claude Code CLI or Claude Desktop). ' +
  'Do the task you are given directly. Ignore any CLAUDE.md instructions about orchestrating or delegating to CLI workers, ' +
  'do not use the worker-boss skill or the /worker-run command, and do not use cc_start. The boss session is your boss: plan and implement the whole task yourself without waiting for ' +
  'plan approval; it answers your questions while you work and reviews the finished code at the end. Follow its answers and corrections. ' +
  'Make reasonable decisions yourself; when you genuinely need one from the boss, ask one clear question with context — ' +
  'what you are doing, what you found (files, errors), the options you see and which you recommend — then wait for the answer. ' +
  'Save tokens: write short — answer first, no greetings, recaps or narration between tool calls; keep code, commands, paths and ' +
  'error messages exact. Read test/build output through a filter (summary lines and the first error, e.g. | Select-Object -Last 30 or | tail -30), ' +
  'not the full log. When you finish a task, end with a block that starts with the line "## Worker report" and lists: files changed, ' +
  'tests/build run and their result, anything left open. Keep it under 15 lines.'

// The same report as JSON, written to a file the boss reads with cc_report (the folder is passed with --add-dir).
const reportPrompt = (file) => ` Just before the "## Worker report" block, write that report as JSON to ${file} (overwrite it): ` +
  '{"status":"done"|"blocked","summary":"<one line>","files_changed":["<path>"],"tests":[{"command":"<cmd>","result":"pass"|"fail"|"not run","detail":"<short>"}],"open":["<item>"]}.'

// Effort per worker model when the boss does not set one: easy work thinks less.
const EFFORT = { haiku: 'low', sonnet: 'medium', opus: 'high' }
const reportFile = (name) => path.join(reportsDir, `${name.toLowerCase()}.json`)

// Plugins the user has enabled, turned off for lean workers (they bring skills, hooks and MCP servers
// a worker rarely needs, and their text rides along on every request).
function leanPlugins() {
  try {
    const on = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).enabledPlugins ?? {}
    return Object.fromEntries(Object.keys(on).filter((k) => on[k]).map((k) => [k, false]))
  } catch { return {} }
}

const AUTOCOMPACT = 200000
// Cap on lines a since_send read returns, so a long worker reply does not flood the boss's context.
const MAX_LINES = 150

function defaultPermissionMode() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).permissions?.defaultMode ?? 'default' } catch { return 'default' }
}

const ok = (text) => ({ content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text, null, 2) }] })
const err = (text) => ({ content: [{ type: 'text', text }], isError: true })

// Wrap a handler so bridge errors come back as tool errors instead of protocol failures.
const guard = (fn) => async (args) => {
  try { return await fn(args) } catch (e) {
    if (e instanceof NotRunning) return err(`${e.message} (use cc_list to see live runs)`)
    return err(String(e.message || e))
  }
}

const nameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/i).describe('Run name: letters, digits, dashes, max 32')

const server = new McpServer({ name: 'claude-code-worker', title: 'Claude Code Worker', version: '1.7.1' })

// ---------- runs ----------

const startSchema = {
  name: nameSchema,
  cwd: z.string().optional().describe('Working directory for the run (default: this server\'s cwd)'),
  role: z.string().optional().describe('Worker preset: implementer, explorer, tester, reviewer, docs, or one from ~/.claude/cc-workers/roles.json (cc_roles lists them). Sets model, effort, permission mode and a role note; explicit arguments win'),
  model: z.string().optional().describe('claude model for the run: haiku, sonnet, opus, or a full model id. Switch later with cc_send "/model <name>"'),
  permission_mode: z.enum(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']).optional().describe('Permission mode for the run (default: the user\'s settings defaultMode, reported in the result)'),
  autocompact: z.number().int().min(50000).optional().describe('Auto-compact the worker\'s context at this many tokens (default 200000)'),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().describe('Effort level (default by model: haiku low, sonnet medium, opus high)'),
  lean: z.boolean().optional().describe('Start without MCP servers and plugins to save tokens (default true). Set false when the task needs an MCP server or plugin skill, e.g. a database MCP'),
  worktree: z.union([z.boolean(), z.string()]).optional().describe('Run in its own git worktree (<repo>-worktrees/<name>) on branch worker/<name>, or on the branch named here, so parallel workers do not touch each other\'s files. Starts from HEAD: uncommitted changes are not carried over'),
  restart: z.number().int().min(0).max(10).optional().describe('Restart a crashed worker (non-zero exit not caused by cc_stop) up to this many times, resuming its conversation (default 2; 0 = never)'),
  budget_tokens: z.number().int().min(10000).optional().describe('Stop the worker when its tokens (input + cache writes + output) pass this; an over_budget event is emitted'),
  args: z.array(z.string()).optional().describe('Extra claude arguments, e.g. ["--resume","<id>"], or a first prompt as the last item'),
  command: z.array(z.string()).optional().describe('Run this command instead of claude (for testing), e.g. ["powershell","-NoLogo"]'),
  visible: z.boolean().optional(),
  cols: z.number().int().min(40).max(400).optional().describe('Terminal width for hidden runs (default 120)'),
  rows: z.number().int().min(10).max(200).optional().describe('Terminal height for hidden runs (default 30)'),
}

// Start a worker run and return once its control channel is up. Throws on failure.
async function startWorker({ name, cwd, role, model, permission_mode, autocompact = AUTOCOMPACT, effort, lean = true, worktree, restart = 2, budget_tokens, args = [], command, visible = true, cols, rows }) {
  if (process.env.CC_BRIDGE_WORKER) throw new Error('this session is itself a Claude Code Worker; workers do not start workers')
  const existing = readSession(name)
  if (existing && pidAlive(existing.pid)) throw new Error(`run "${name}" is already running (pid ${existing.pid})`)
  let workDir = path.resolve(cwd || process.cwd())
  if (!fs.statSync(workDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`not a directory: ${workDir}`)
  let preset = {}
  if (role) {
    preset = loadRoles()[role]
    if (!preset) throw new Error(`unknown role "${role}"; known: ${Object.keys(loadRoles()).join(', ')}`)
  }
  model ??= preset.model
  permission_mode ??= preset.permission_mode
  const wt = worktree ? createWorktree(workDir, name, typeof worktree === 'string' ? worktree : undefined) : null
  if (wt) workDir = wt.cwd

  const specFile = path.join(sessionDir, `${name.toLowerCase()}.spec.json`)
  const logFile = path.join(sessionDir, `${name.toLowerCase()}.log`)
  fs.mkdirSync(reportsDir, { recursive: true })
  fs.rmSync(reportFile(name), { force: true })
  // Workers always use the inline TUI: the user's "tui": "fullscreen" puts claude on the alternate
  // screen, which has no scrollback, so long replies scroll away before they can be read.
  effort ??= preset.effort ?? EFFORT[model?.toLowerCase()]
  // A known session id finds the transcript (token use) and lets a crashed run be resumed.
  const resuming = args.some((a) => ['--resume', '-r', '--continue', '-c', '--session-id'].includes(a))
  const sessionId = command || resuming ? null : crypto.randomUUID()
  const flags = [
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
    ...(permission_mode ? ['--permission-mode', permission_mode] : []),
    '--autocompact', String(autocompact),
    ...(lean ? ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'] : []),
    '--settings', JSON.stringify({ tui: 'default', ...(lean ? { enabledPlugins: leanPlugins() } : {}) }),
    '--add-dir', reportsDir,
  ]
  const prompt = WORKER_PROMPT + reportPrompt(reportFile(name)) + (preset.prompt ? ` ${preset.prompt}` : '')
  const full = command ?? ['claude', ...flags, ...(sessionId ? ['--session-id', sessionId] : []), '--append-system-prompt', prompt, ...args]
  const display = command ? command.join(' ') : ['claude', ...flags, '--append-system-prompt', '<worker prompt>', ...args].join(' ')
  const meta = { ...(role ? { role } : {}), ...(model ? { model } : {}), ...(wt ? { worktree: wt.path, branch: wt.branch } : {}) }
  fs.writeFileSync(specFile, JSON.stringify({
    command: full, display, cols, rows, meta, sessionId, reportFile: command ? undefined : reportFile(name), budgetTokens: sessionId ? budget_tokens : undefined,
    // resume continues the conversation; fresh is for a crash before the first message (nothing to resume).
    restart: sessionId && restart ? { max: restart, command: ['claude', ...flags, '--append-system-prompt', prompt, '--resume', sessionId], fresh: full } : undefined,
  }), { mode: 0o600 })
  const mode = command ? undefined : permission_mode ?? `${defaultPermissionMode()} (from settings)`

  const env = { ...childEnv(), CC_BRIDGE_WORKER: name }
  if (visible && process.platform === 'win32') {
    // `start` opens a new console window. Only fixed paths and the validated name are on this
    // command line; the command and its arguments travel in the spec file.
    for (const p of [workDir, process.execPath, bridgeScript, specFile]) if (p.includes('"')) throw new Error(`path contains a quote: ${p}`)
    const line = `start "Claude Code Worker ${name}" /D "${workDir}" "${process.execPath}" "${bridgeScript}" start ${name} --spec "${specFile}"`
    spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { env, detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).on('error', () => {}).unref()
  } else {
    // Hidden runs (and every run outside Windows) write the terminal stream to <name>.log so a failed
    // start can be diagnosed.
    const log = fs.openSync(logFile, 'w')
    // A failed spawn must not take the MCP server down; the start loop below reports the timeout.
    const child = spawn(process.execPath, [bridgeScript, 'start', name, '--spec', specFile], { cwd: workDir, env, detached: true, stdio: ['ignore', log, log], windowsHide: true })
    child.on('error', (e) => { try { fs.appendFileSync(logFile, `cannot start: ${e.message}
`) } catch {} })
    child.unref()
    fs.closeSync(log)
  }

  for (let i = 0; i < 60; i++) {
    const s = readSession(name)
    if (s) {
      // A new worktree folder is not trusted yet; it is the user's own repo, so accept the prompt.
      if (wt?.created && !command) acceptTrust(name)
      return { started: name, pid: s.pid, command: s.command, cwd: s.cwd, visible: visible && process.platform === 'win32',
        ...(mode ? { permission_mode: mode, autocompact, effort: effort ?? '<default>', lean, restart, ...(budget_tokens ? { budget_tokens } : {}) } : {}),
        ...meta, ...(sessionId ? { session_id: sessionId } : {}),
        // Run one of these in the background to be woken when the worker finishes, instead of polling cc_wait.
        wait_command: `node "${ctlScript}" wait ${name} --done --quiet --timeout 3600`,
        wait_any_command: `node "${ctlScript}" wait-any --quiet --timeout 3600` }
    }
    await sleep(250)
  }
  try { fs.unlinkSync(specFile) } catch {}
  let tail = ''
  try { tail = fs.readFileSync(logFile, 'utf8').slice(-2000) } catch {}
  throw new Error(`run "${name}" did not come up within 15 s${tail ? `\n${tail}` : ''}`)
}

// Press Enter on the folder trust prompt if it shows within 30 s (option 1 is "Yes, I trust this folder").
async function acceptTrust(name) {
  try {
    const r = await waitFor(name, { match: 'Do you trust the files|trust this folder', timeoutSec: 30 })
    if (r.met) await call(name, 'POST', '/key', { key: 'Enter' })
  } catch {}
}

server.registerTool('cc_start', {
  description: 'Start a Claude Code Worker: an interactive claude CLI run under cc-bridge. visible=true (default) opens it in a new terminal window the user can watch and type in; visible=false runs it hidden (always hidden outside Windows). Returns once the control channel is up, with wait_command / wait_any_command to run in the background. The run uses the CLI account from the environment, not this session\'s.',
  inputSchema: startSchema,
}, guard(async (a) => ok(await startWorker(a))))

server.registerTool('cc_roles', {
  description: 'List worker roles for cc_start / cc_queue_add `role`: built-in presets plus ~/.claude/cc-workers/roles.json.',
  inputSchema: {},
}, guard(async () => ok(loadRoles())))

server.registerTool('cc_list', {
  description: 'List live Claude Code Worker runs: name, state (working, done, question, permission, idle), tokens used, role, model, worktree/branch, cwd, start time.',
  inputSchema: {},
}, guard(async () => ok(await Promise.all(listSessions().map(async ({ command, ...s }) => {
  try {
    const st = await call(s.name, 'GET', '/status')
    return { ...s, state: st.state, ...(st.usage ? { tokens: st.usage.tokens, context: st.usage.context } : {}), ...(st.restarts ? { restarts: st.restarts } : {}) }
  } catch { return { ...s, state: 'unreachable' } }
})))))

server.registerTool('cc_screen', {
  description: 'Read the rendered terminal screen of a run. since_send=true returns the output from the last cc_send to now (its last max_lines lines, default 150; 0 = all); otherwise the visible screen plus optional scrollback lines.',
  inputSchema: { name: nameSchema, since_send: z.boolean().optional(), scrollback: z.number().int().min(0).max(2000).optional(), max_lines: z.number().int().min(0).optional() },
}, guard(async ({ name, since_send = false, scrollback = 0, max_lines = MAX_LINES }) => ok(await screenText(name, since_send, scrollback, max_lines))))

async function screenText(name, sinceSend, scrollback = 0, maxLines = MAX_LINES) {
  const s = await call(name, 'GET', `/screen?scrollback=${scrollback}${sinceSend ? '&since=send' : ''}`)
  const idle = Math.round((Date.now() - s.lastOutputAt) / 1000)
  const state = s.exited ? 'exited' : WORKING.test(s.text) ? 'working' : 'idle'
  const note = sinceSend && !s.sinceSend ? ', since_send unavailable: visible screen only' : sinceSend ? ', since last send' : ''
  let text = s.text
  // A finished worker ends with "## Worker report": that block is all the boss needs.
  const rep = sinceSend && maxLines && state === 'idle' ? ([...text.matchAll(REPORT)].at(-1)?.index ?? -1) : -1
  if (rep >= 0) text = `[worker report only; max_lines=0 for the full output]\n${text.slice(rep)}`
  const lines = text.split('\n')
  if (sinceSend && maxLines && lines.length > maxLines) text = `[${lines.length - maxLines} earlier lines omitted; max_lines=0 for all]\n${lines.slice(-maxLines).join('\n')}`
  const json = sinceSend && state === 'idle' ? readReport(name, s.lastSendAt) : null
  return `[${name} ${state}, last output ${idle}s ago${note}]\n${json ? `report.json: ${JSON.stringify(json.report)}\n` : ''}${text}`
}

// The worker's JSON report, when it was written after `since` (ms). { report, fresh, written } or null.
function readReport(name, since = 0) {
  const file = reportFile(name)
  const st = fs.statSync(file, { throwIfNoEntry: false })
  if (!st || st.mtimeMs <= since) return null
  try { return { report: JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')), written: st.mtime.toISOString() } } catch (e) { return { report: { error: `unreadable report: ${e.message}` }, written: st.mtime.toISOString() } }
}

server.registerTool('cc_send', {
  description: 'Type text into a run, optionally pressing Enter. Use it for prompts and slash commands, e.g. "/model opus", "/permissions", "/mcp", "/clear", "/compact". Multi-line text is safe: it is sent as one bracketed paste, so newlines do not submit early, and Enter submits it once. Sent text cannot be recalled, so write it in full before sending. Call cc_wait first so you do not type over the user or a busy run.',
  inputSchema: { name: nameSchema, text: z.string(), enter: z.boolean().optional().describe('Press Enter after the text (default true)') },
}, guard(async ({ name, text, enter = true }) => {
  await call(name, 'POST', '/send', { text, enter })
  return ok('sent')
}))

server.registerTool('cc_key', {
  description: 'Press a key in a run. ShiftTab cycles the permission mode (default → accept edits → plan); Up/Down/Enter answer menus; Esc interrupts; CtrlC cancels.',
  inputSchema: { name: nameSchema, key: z.enum(Object.keys(KEYS)), repeat: z.number().int().min(1).max(50).optional() },
}, guard(async ({ name, key, repeat = 1 }) => {
  await call(name, 'POST', '/key', { key, repeat })
  return ok(`pressed ${key}${repeat > 1 ? ` x${repeat}` : ''}`)
}))

server.registerTool('cc_wait', {
  description: 'Block until a condition, then return the screen. done=true waits for the claude worker to finish its turn (no "esc to interrupt" in the status line, screen steady 2 s) — use this after sending a task; it also returns when the worker stops to ask a question or show a menu. idle waits for the screen to be unchanged for that many seconds; match waits for a regex (multiline). since_send=true returns the output since the last cc_send (its last max_lines lines, default 150) instead of the visible screen. On timeout only a one-line status comes back, to save context. Many MCP clients cut tool calls off at 60 s, so keep timeout at 50 or less and call again on "timed out" (the worker is still working).',
  inputSchema: {
    name: nameSchema,
    done: z.boolean().optional(),
    idle: z.number().min(0.5).max(600).optional(),
    match: z.string().optional(),
    since_send: z.boolean().optional(),
    max_lines: z.number().int().min(0).optional().describe('With since_send: return at most this many last lines (default 150, 0 = all)'),
    timeout: z.number().min(1).max(1800).optional().describe('Seconds before giving up (default 50)'),
  },
}, guard(async ({ name, done, idle, match, since_send = false, max_lines = MAX_LINES, timeout = 50 }) => {
  if (!done && !idle && !match) return err('give done, idle, or match')
  if (match) try { new RegExp(match, 'm') } catch (e) { return err(`bad regex: ${e.message}`) }
  const r = await waitFor(name, { done, idleSec: idle, match, timeoutSec: timeout })
  const head = r.met ? 'condition met' : r.exited ? 'run exited' : `timed out after ${timeout}s, still working`
  // A timeout means "still working": return only the status line, not the whole screen.
  const status = (r.text.split('\n').find((l) => WORKING.test(l)) ?? '').trim().slice(0, 200)
  const body = r.timedOut ? status : r.exited || !since_send ? r.text : await screenText(name, true, 0, max_lines)
  return { ...ok(`[${head}]\n${body}`), isError: r.timedOut }
}))

server.registerTool('cc_status', {
  description: 'Status of a run: pids, running, exit code, size, last output time.',
  inputSchema: { name: nameSchema },
}, guard(async ({ name }) => ok(await call(name, 'GET', '/status'))))

server.registerTool('cc_stop', {
  description: 'Stop a run: Ctrl-C twice, then kill after 3 s. Returns once the run is gone (up to 8 s).',
  inputSchema: { name: nameSchema },
}, guard(async ({ name }) => {
  const pid = readSession(name)?.pid
  await call(name, 'POST', '/stop')
  for (let i = 0; i < 32; i++) {
    if (!readSession(name) || (pid && !pidAlive(pid))) { removeSession(name); return ok(`stopped ${name}`) }
    await sleep(250)
  }
  return err(`${name} did not exit within 8 s (pid ${pid}); check cc_status`)
}))

server.registerTool('cc_wait_any', {
  description: 'Block until any worker (or one of `names`) changes state, then return the events: done (finished with a report), question (stopped to ask), permission (a menu waits), exited, restarted, over_budget. Pass the returned cursor as `since` next time so nothing is missed. Keep timeout ≤ 50; for longer waits run the returned wait_any_command in the background instead.',
  inputSchema: {
    names: z.array(nameSchema).optional(),
    since: z.number().optional().describe('Only events after this cursor (ms); default: now'),
    timeout: z.number().min(1).max(1800).optional().describe('Seconds (default 50)'),
  },
}, guard(async ({ names = [], since, timeout = 50 }) => {
  const r = await waitAny({ since: since ?? Date.now(), names, timeoutSec: timeout })
  const cmd = `node "${ctlScript}" wait-any ${names.join(' ')} --since ${r.cursor} --quiet --timeout 3600`.replace(/ {2,}/g, ' ')
  return { ...ok({ timed_out: r.timedOut, events: r.events.map((e) => ({ ...e, at: new Date(e.t).toISOString() })), cursor: r.cursor, wait_any_command: cmd }), isError: r.timedOut }
}))

server.registerTool('cc_report', {
  description: 'Read a worker\'s structured JSON report ({status, summary, files_changed, tests, open}), written when it finishes a task. `fresh` is false when the report predates the last cc_send (it belongs to an earlier task).',
  inputSchema: { name: nameSchema },
}, guard(async ({ name }) => {
  let lastSendAt = 0
  try { lastSendAt = (await call(name, 'GET', '/status')).lastSendAt ?? 0 } catch {}
  const r = readReport(name)
  if (!r) return err(`no report from ${name} yet (${reportFile(name)})`)
  return ok({ name, ...r, fresh: Date.parse(r.written) > lastSendAt })
}))

// ---------- task queue ----------

const taskSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/i).describe('Task id; also the worker name unless `name` is given'),
  name: nameSchema.optional(),
  prompt: z.string().min(1).describe('The self-contained brief sent to the worker once it is ready'),
  depends_on: z.array(z.string()).optional().describe('Task ids that must be done first; if one fails the task is blocked'),
  cwd: z.string().optional(),
  role: z.string().optional(),
  model: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  permission_mode: z.enum(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']).optional(),
  worktree: z.union([z.boolean(), z.string()]).optional(),
  lean: z.boolean().optional(),
  budget_tokens: z.number().int().min(10000).optional(),
  restart: z.number().int().min(0).max(10).optional(),
  visible: z.boolean().optional(),
  command: z.array(z.string()).optional().describe('Run this command instead of claude (for testing)'),
})

// Start a queued task's worker, wait for its prompt, and send the brief.
async function startTask(t) {
  await startWorker({ ...t.worker, name: t.name })
  let r = await waitFor(t.name, { done: true, timeoutSec: 90 })
  if (/Do you trust the files|trust this folder/i.test(r.text)) {
    await call(t.name, 'POST', '/key', { key: 'Enter' })
    r = await waitFor(t.name, { done: true, timeoutSec: 60 })
  }
  if (r.exited) throw new Error('worker exited before it was ready')
  // Just after its first screen settles claude drops an Enter; give it a moment.
  await sleep(3000)
  await call(t.name, 'POST', '/send', { text: t.prompt, enter: true })
}

const runTick = () => tick({ start: startTask, status: (n) => call(n, 'GET', '/status') }).catch(() => {})

server.registerTool('cc_queue_add', {
  description: 'Queue worker tasks. Each starts as its own worker (default visible, same options as cc_start) once its depends_on tasks are done and fewer than max_parallel queued workers are active; the brief is sent when the worker is ready. Finished workers stay up for review: cc_stop them yourself. Wake on changes with cc_wait_any / wait_any_command; see progress with cc_queue_list. The scheduler runs inside this MCP server, so it only advances while this session is open.',
  inputSchema: { tasks: z.array(taskSchema).min(1), max_parallel: z.number().int().min(1).max(10).optional().describe('Active queued workers at once (default 3; kept for later adds)') },
}, guard(async ({ tasks, max_parallel }) => {
  const live = new Set(listSessions().map((s) => s.name.toLowerCase()))
  const rows = tasks.map(({ id, name, prompt, depends_on, ...worker }) => {
    const n = name ?? id
    if (live.has(n.toLowerCase())) throw new Error(`a worker named ${n} is already running`)
    return { id, name: n, prompt, depends_on, worker }
  })
  const added = addTasks(rows, max_parallel)
  await runTick()
  return ok({ queued: added.map((t) => t.id), queue: summarizeQueue(), wait_any_command: `node "${ctlScript}" wait-any --quiet --timeout 3600` })
}))

function summarizeQueue() {
  const q = loadQueue()
  return { max_parallel: q.max_parallel, tasks: q.tasks.map(({ prompt, worker, ...t }) => ({ ...t, ...(worker.worktree ? { worktree: worker.worktree } : {}) })) }
}

server.registerTool('cc_queue_list', {
  description: 'Show the task queue: each task\'s state (pending, starting, running, needs_input, done, failed, blocked, cancelled), worker name, dependencies and errors.',
  inputSchema: {},
}, guard(async () => { await runTick(); return ok(summarizeQueue()) }))

server.registerTool('cc_queue_cancel', {
  description: 'Cancel queued tasks (ids, or all=true). Pending tasks are dropped from the schedule; with stop_workers=true running ones have their worker stopped too. clear_finished=true removes done/failed/blocked/cancelled tasks from the list.',
  inputSchema: { ids: z.array(z.string()).optional(), all: z.boolean().optional(), stop_workers: z.boolean().optional(), clear_finished: z.boolean().optional() },
}, guard(async ({ ids = [], all = false, stop_workers = false, clear_finished = false }) => {
  const q = loadQueue()
  const cancelled = []
  for (const t of q.tasks) {
    if (FINAL.has(t.state) || !(all || ids.includes(t.id))) continue
    if (t.state !== 'pending' && !stop_workers) continue
    if (t.state !== 'pending') try { await call(t.name, 'POST', '/stop') } catch {}
    t.state = 'cancelled'
    t.finished = new Date().toISOString()
    cancelled.push(t.id)
  }
  if (clear_finished) q.tasks = q.tasks.filter((t) => !FINAL.has(t.state))
  saveQueue(q)
  return ok({ cancelled, queue: summarizeQueue() })
}))

// ---------- worktrees ----------

server.registerTool('cc_worktree', {
  description: 'Worker git worktrees of the repo at cwd (<repo>-worktrees/<name>). list: name, path, branch, head, dirty. remove: delete a worker\'s worktree (refused when it has uncommitted changes unless force), and its branch with delete_branch (git branch -d; -D with force). Merge a worker branch yourself with git before removing it.',
  inputSchema: {
    action: z.enum(['list', 'remove']),
    cwd: z.string().describe('Any folder inside the main repo'),
    name: nameSchema.optional(),
    delete_branch: z.boolean().optional(),
    force: z.boolean().optional(),
  },
}, guard(async ({ action, cwd, name, delete_branch = false, force = false }) => {
  if (action === 'list') return ok(listWorktrees(path.resolve(cwd)))
  if (!name) return err('name is required for remove')
  const s = readSession(name)
  if (s && pidAlive(s.pid)) return err(`worker ${name} is still running: cc_stop it first`)
  return ok(removeWorktree(path.resolve(cwd), name, { deleteBranch: delete_branch, force }))
}))

// ---------- asking the user ----------

server.registerTool('cc_ask_user', {
  description: 'Ask the user one question in a desktop dialog (one button per option plus a free-text box) that closes by itself after timeout_sec (default 120). Use it instead of waiting in chat when you are running unattended and need the user\'s decision. Waits up to wait_sec (default 50) for the answer; if the dialog is still open it returns pending with an id: call cc_ask_result. If the user does not answer (answered=false), decide yourself: analyze the question, pick the best option for the user\'s goal and the codebase, say which and why, record it as a decision in your final summary, and carry on. For irreversible or risky choices (deleting data, publishing, force pushes, spending money, credentials) pick the safe, non-destructive option.',
  inputSchema: {
    question: z.string().min(1).max(2000),
    options: z.array(z.string().min(1).max(200)).max(8).optional().describe('Answer choices; the user can also type a free answer'),
    recommended: z.string().optional().describe('The option you would pick; marked "(recommended)" in the dialog'),
    timeout_sec: z.number().int().min(10).max(3600).optional().describe('Seconds before the dialog closes unanswered (default 120)'),
    wait_sec: z.number().int().min(0).max(55).optional().describe('Seconds this call waits for the answer (default 50)'),
  },
}, guard(async ({ question, options = [], recommended, timeout_sec = 120, wait_sec = 50 }) => {
  const id = startAsk({ question, options, recommended, timeoutSec: timeout_sec })
  return askResult(id, wait_sec)
}))

server.registerTool('cc_ask_result', {
  description: 'Wait up to wait_sec (default 50) for the answer to a pending cc_ask_user dialog.',
  inputSchema: { id: z.string(), wait_sec: z.number().int().min(0).max(55).optional() },
}, guard(async ({ id, wait_sec = 50 }) => askResult(id, wait_sec)))

async function askResult(id, waitSec) {
  const r = await waitAsk(id, waitSec)
  if (!r) return ok({ id, pending: true, next: 'call cc_ask_result with this id' })
  if (!r.answered) return ok({ ...r, next: 'No answer from the user: decide yourself — pick the best option, state why, log it as a decision for the final summary (safe option for risky or irreversible choices).' })
  return ok(r)
}

// ---------- maintenance ----------

server.registerTool('cc_doctor', {
  description: 'Check the worker setup: Node version, dependencies, claude CLI, git, state folder, stale sessions, ask dialog. Run it when cc_start or the MCP server misbehaves.',
  inputSchema: {},
}, guard(async () => {
  const checks = await doctor()
  return ok({ ok: checks.every((c) => c.ok), checks })
}))

server.registerTool('cc_cleanup', {
  description: 'Remove leftovers of dead runs: session files of dead processes, unread spec files, and logs/reports/asks older than `days` (default 3) of runs that are gone; keep the last 1000 events. Live workers are not touched.',
  inputSchema: { days: z.number().min(0).max(365).optional() },
}, guard(async ({ days = 3 }) => ok(cleanup({ days }))))

// ---------- claude CLI management commands ----------

const CLI_ALLOWED = new Set(['mcp', 'plugin', 'plugins', '--version'])
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

server.registerTool('cc_cli', {
  description: 'Run a non-interactive claude management command and return its output. Allowed first arguments: mcp, plugin, plugins, --version. Examples: ["mcp","list"], ["mcp","get","context7"], ["mcp","add","-s","user","my-srv","--","npx","pkg"], ["mcp","remove","my-srv","-s","user"], ["plugin","list"], ["plugin","enable","name@marketplace"], ["plugin","marketplace","list"].',
  inputSchema: {
    args: z.array(z.string()).min(1),
    cwd: z.string().optional().describe('Directory to run in (matters for project and local scope)'),
    stdin: z.string().optional().describe('Text piped to stdin, e.g. for plugin configure --values-stdin'),
    timeout: z.number().min(1).max(600).optional().describe('Seconds (default 90)'),
  },
}, guard(async ({ args, cwd, stdin, timeout = 90 }) => {
  if (!CLI_ALLOWED.has(args[0])) return err(`first argument must be one of: ${[...CLI_ALLOWED].join(', ')}`)
  const [file, fileArgs] = resolveCommand('claude', args)
  const result = await new Promise((resolve) => {
    const child = execFile(file, fileArgs, { cwd: cwd ? path.resolve(cwd) : process.cwd(), env: childEnv(), timeout: timeout * 1000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (e, stdout, stderr) => resolve({ code: e ? (e.code ?? 1) : 0, killed: e?.killed, stdout, stderr }))
    child.stdin.end(stdin ?? '')
  })
  const out = [`exit ${result.code}${result.killed ? ' (timed out)' : ''}`, result.stdout.replace(ANSI, '').trim(), result.stderr.replace(ANSI, '').trim()].filter(Boolean).join('\n')
  return { ...ok(out), isError: result.code !== 0 }
}))

// ---------- settings.json ----------

const scopeSchema = z.enum(['user', 'project', 'local']).describe('user = ~/.claude/settings.json, project = <cwd>/.claude/settings.json, local = <cwd>/.claude/settings.local.json')

function settingsPath(scope, cwd) {
  if (scope === 'user') return path.join(os.homedir(), '.claude', 'settings.json')
  if (!cwd) throw new Error(`cwd is required for ${scope} scope`)
  return path.join(path.resolve(cwd), '.claude', scope === 'project' ? 'settings.json' : 'settings.local.json')
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) {
    if (e.code === 'ENOENT') return {}
    throw new Error(`cannot parse ${file}: ${e.message}`)
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
}

const keyParts = (key) => key.split('.').filter(Boolean)

server.registerTool('cc_settings_get', {
  description: 'Read a Claude Code settings file, or one dotted key in it (e.g. "model", "permissions.defaultMode", "env").',
  inputSchema: { scope: scopeSchema, cwd: z.string().optional(), key: z.string().optional() },
}, guard(async ({ scope, cwd, key }) => {
  const file = settingsPath(scope, cwd)
  let v = readJson(file)
  for (const k of key ? keyParts(key) : []) v = v?.[k]
  return ok({ file, ...(key ? { key } : {}), value: v ?? null })
}))

server.registerTool('cc_settings_set', {
  description: 'Set or delete one dotted key in a Claude Code settings file, e.g. key "model" value "opus", key "permissions.defaultMode" value "acceptEdits", key "env.MY_VAR" value "1". Omit value to delete the key. Running CLI sessions pick up most changes on their next turn; some need a restart.',
  inputSchema: { scope: scopeSchema, cwd: z.string().optional(), key: z.string().min(1), value: z.any().optional() },
}, guard(async ({ scope, cwd, key, value }) => {
  const file = settingsPath(scope, cwd)
  const data = readJson(file)
  const parts = keyParts(key)
  let obj = data
  for (const k of parts.slice(0, -1)) {
    if (typeof obj[k] !== 'object' || obj[k] === null || Array.isArray(obj[k])) obj[k] = {}
    obj = obj[k]
  }
  const last = parts.at(-1)
  if (value === undefined) delete obj[last]; else obj[last] = value
  writeJson(file, data)
  return ok({ file, key, value: value ?? null, action: value === undefined ? 'deleted' : 'set' })
}))

server.registerTool('cc_permission', {
  description: 'Add or remove a permission rule in a settings file, e.g. list "allow" rule "Bash(npm test:*)", list "deny" rule "Read(./.env)".',
  inputSchema: {
    scope: scopeSchema,
    cwd: z.string().optional(),
    action: z.enum(['add', 'remove']),
    list: z.enum(['allow', 'deny', 'ask']),
    rule: z.string().min(1),
  },
}, guard(async ({ scope, cwd, action, list, rule }) => {
  const file = settingsPath(scope, cwd)
  const data = readJson(file)
  data.permissions ??= {}
  const rules = new Set(data.permissions[list] ?? [])
  const had = rules.has(rule)
  if (action === 'add') rules.add(rule); else rules.delete(rule)
  data.permissions[list] = [...rules]
  writeJson(file, data)
  return ok({ file, list, rule, changed: action === 'add' ? !had : had, rules: data.permissions[list] })
}))

// Clear what dead runs left behind, then advance the task queue every 3 s while it has open tasks.
try { cleanup() } catch {}
setInterval(() => { if (loadQueue().tasks.some((t) => !FINAL.has(t.state))) runTick() }, 3000).unref()

await server.connect(new StdioServerTransport())
