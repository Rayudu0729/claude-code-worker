// Claude Code Worker: MCP server (stdio) that gives a Claude Code / Desktop session native tools for cc-bridge runs,
// the claude CLI's mcp/plugin subcommands, and settings.json files.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { validName, readSession, removeSession, sessionDir, pidAlive } from './lib/session.mjs'
import { call, listSessions, waitFor, NotRunning, WORKING } from './lib/client.mjs'
import { KEYS } from './lib/keys.mjs'
import { resolveCommand, childEnv } from './lib/command.mjs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const bridgeScript = path.join(dir, 'cc-bridge.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Appended to every claude worker's system prompt so it does not follow the orchestrator rules in
// the global CLAUDE.md (and start workers of its own).
const WORKER_PROMPT = 'You are a Claude Code Worker run (cc-bridge), started and driven by a Claude Desktop orchestrator session. ' +
  'Do the task you are given directly. Ignore any CLAUDE.md instructions about orchestrating or delegating to CLI workers, ' +
  'do not use the worker-boss skill or the /worker-run command, and do not use cc_start. The orchestrator is your boss: plan and implement the whole task yourself without waiting for ' +
  'plan approval; it answers your questions while you work and reviews the finished code at the end. Follow its answers and corrections. ' +
  'If you need a decision, ask it plainly in one question and wait.'

const AUTOCOMPACT = 400000

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

const server = new McpServer({ name: 'claude-code-worker', title: 'Claude Code Worker', version: '1.2.0' })

// ---------- runs ----------

server.registerTool('cc_start', {
  description: 'Start a Claude Code Worker: an interactive claude CLI run under cc-bridge. visible=true (default) opens it in a new terminal window the user can watch and type in; visible=false runs it hidden. Returns once the control channel is up. The run uses the CLI account from the environment, not this session\'s.',
  inputSchema: {
    name: nameSchema,
    cwd: z.string().optional().describe('Working directory for the run (default: this server\'s cwd)'),
    model: z.string().optional().describe('claude model for the run: haiku, sonnet, opus, or a full model id. Switch later with cc_send "/model <name>"'),
    permission_mode: z.enum(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']).optional().describe('Permission mode for the run (default: the user\'s settings defaultMode, reported in the result)'),
    autocompact: z.number().int().min(50000).optional().describe('Auto-compact the worker\'s context at this many tokens (default 400000)'),
    args: z.array(z.string()).optional().describe('Extra claude arguments, e.g. ["--resume","<id>"], or a first prompt as the last item'),
    command: z.array(z.string()).optional().describe('Run this command instead of claude (for testing), e.g. ["powershell","-NoLogo"]'),
    visible: z.boolean().optional(),
    cols: z.number().int().min(40).max(400).optional().describe('Terminal width for hidden runs (default 120)'),
    rows: z.number().int().min(10).max(200).optional().describe('Terminal height for hidden runs (default 30)'),
  },
}, guard(async ({ name, cwd, model, permission_mode, autocompact = AUTOCOMPACT, args = [], command, visible = true, cols, rows }) => {
  if (process.env.CC_BRIDGE_WORKER) return err('this session is itself a Claude Code Worker; workers do not start workers')
  const existing = readSession(name)
  if (existing && pidAlive(existing.pid)) return err(`run "${name}" is already running (pid ${existing.pid})`)
  const workDir = path.resolve(cwd || process.cwd())
  if (!fs.statSync(workDir, { throwIfNoEntry: false })?.isDirectory()) return err(`not a directory: ${workDir}`)

  const specFile = path.join(sessionDir, `${name.toLowerCase()}.spec.json`)
  const logFile = path.join(sessionDir, `${name.toLowerCase()}.log`)
  fs.mkdirSync(sessionDir, { recursive: true })
  // Workers always use the inline TUI: the user's "tui": "fullscreen" puts claude on the alternate
  // screen, which has no scrollback, so long replies scroll away before they can be read.
  const flags = [
    ...(model ? ['--model', model] : []),
    ...(permission_mode ? ['--permission-mode', permission_mode] : []),
    '--autocompact', String(autocompact),
    '--settings', JSON.stringify({ tui: 'default' }),
  ]
  const full = command ?? ['claude', ...flags, '--append-system-prompt', WORKER_PROMPT, ...args]
  const display = command ? command.join(' ') : ['claude', ...flags, '--append-system-prompt', '<worker prompt>', ...args].join(' ')
  fs.writeFileSync(specFile, JSON.stringify({ command: full, display, cols, rows }), { mode: 0o600 })
  const mode = command ? undefined : permission_mode ?? `${defaultPermissionMode()} (from settings)`

  const env = { ...childEnv(), CC_BRIDGE_WORKER: name }
  if (visible && process.platform === 'win32') {
    // `start` opens a new console window. Only fixed paths and the validated name are on this
    // command line; the command and its arguments travel in the spec file.
    for (const p of [workDir, process.execPath, bridgeScript, specFile]) if (p.includes('"')) return err(`path contains a quote: ${p}`)
    const line = `start "Claude Code Worker ${name}" /D "${workDir}" "${process.execPath}" "${bridgeScript}" start ${name} --spec "${specFile}"`
    spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { env, detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref()
  } else {
    // Hidden runs write the terminal stream to <name>.log so a failed start can be diagnosed.
    const log = fs.openSync(logFile, 'w')
    spawn(process.execPath, [bridgeScript, 'start', name, '--spec', specFile], { cwd: workDir, env, detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref()
    fs.closeSync(log)
  }

  for (let i = 0; i < 60; i++) {
    const s = readSession(name)
    if (s) return ok({ started: name, pid: s.pid, command: s.command, cwd: s.cwd, visible, ...(mode ? { permission_mode: mode, autocompact } : {}) })
    await sleep(250)
  }
  try { fs.unlinkSync(specFile) } catch {}
  let tail = ''
  try { tail = fs.readFileSync(logFile, 'utf8').slice(-2000) } catch {}
  return err(`run "${name}" did not come up within 15 s${tail ? `
${tail}` : ''}`)
}))

server.registerTool('cc_list', {
  description: 'List live Claude Code Worker runs (name, pid, command, cwd, start time).',
  inputSchema: {},
}, guard(async () => ok(listSessions())))

server.registerTool('cc_screen', {
  description: 'Read the rendered terminal screen of a run. since_send=true returns everything from the last cc_send to now (the whole reply, even if it scrolled off screen); otherwise the visible screen plus optional scrollback lines.',
  inputSchema: { name: nameSchema, since_send: z.boolean().optional(), scrollback: z.number().int().min(0).max(2000).optional() },
}, guard(async ({ name, since_send = false, scrollback = 0 }) => ok(await screenText(name, since_send, scrollback))))

async function screenText(name, sinceSend, scrollback = 0) {
  const s = await call(name, 'GET', `/screen?scrollback=${scrollback}${sinceSend ? '&since=send' : ''}`)
  const idle = Math.round((Date.now() - s.lastOutputAt) / 1000)
  const state = s.exited ? 'exited' : WORKING.test(s.text) ? 'working' : 'idle'
  const note = sinceSend && !s.sinceSend ? ', since_send unavailable: visible screen only' : sinceSend ? ', since last send' : ''
  return `[${name} ${state}, last output ${idle}s ago${note}]\n${s.text}`
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
  description: 'Block until a condition, then return the screen. done=true waits for the claude worker to finish its turn (no "esc to interrupt" in the status line, screen steady 2 s) — use this after sending a task; it also returns when the worker stops to ask a question or show a menu. idle waits for the screen to be unchanged for that many seconds; match waits for a regex (multiline). since_send=true returns everything since the last cc_send instead of the visible screen. Many MCP clients cut tool calls off at 60 s, so keep timeout at 50 or less and call again on "timed out" (the worker is still working).',
  inputSchema: {
    name: nameSchema,
    done: z.boolean().optional(),
    idle: z.number().min(0.5).max(600).optional(),
    match: z.string().optional(),
    since_send: z.boolean().optional(),
    timeout: z.number().min(1).max(1800).optional().describe('Seconds before giving up (default 50)'),
  },
}, guard(async ({ name, done, idle, match, since_send = false, timeout = 50 }) => {
  if (!done && !idle && !match) return err('give done, idle, or match')
  if (match) try { new RegExp(match, 'm') } catch (e) { return err(`bad regex: ${e.message}`) }
  const r = await waitFor(name, { done, idleSec: idle, match, timeoutSec: timeout })
  const head = r.met ? 'condition met' : r.exited ? 'run exited' : `timed out after ${timeout}s, still working`
  const body = r.timedOut || r.exited || !since_send ? r.text : await screenText(name, true)
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

await server.connect(new StdioServerTransport())
