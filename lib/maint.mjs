import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { sessionDir, readSession, removeSession, pidAlive } from './session.mjs'
import { resolveCommand, childEnv } from './command.mjs'
import { trimEvents } from './events.mjs'
import { asksDir } from './ask.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DAY = 86400000

// Remove what dead runs left behind: session files of dead pids, spec files nobody read, logs and
// reports of runs that are gone (older than `days`), old asks, and all but the last 1000 events.
export function cleanup({ days = 3 } = {}) {
  const removed = []
  const live = new Set()
  let files = []
  try { files = fs.readdirSync(sessionDir) } catch { return { removed } }
  for (const f of files.filter((x) => /^[a-z0-9-]+\.json$/i.test(x) && x !== 'queue.json')) {
    const name = f.slice(0, -5)
    const s = readSession(name)
    if (s && pidAlive(s.pid)) { live.add(name.toLowerCase()); continue }
    removeSession(name)
    removed.push(f)
  }
  const old = (file) => Date.now() - (fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > days * DAY
  const sweep = (dir, re, keep = () => false) => {
    let list = []
    try { list = fs.readdirSync(dir) } catch { return }
    for (const f of list) {
      const m = f.match(re)
      const file = path.join(dir, f)
      if (m && !keep(m[1]?.toLowerCase()) && old(file)) { fs.rmSync(file, { force: true }); removed.push(path.relative(sessionDir, file)) }
    }
  }
  sweep(sessionDir, /^([a-z0-9-]+)\.(spec\.json|log)$/i, (n) => live.has(n))
  sweep(path.join(sessionDir, 'reports'), /^([a-z0-9-]+)\.json$/i, (n) => live.has(n))
  sweep(asksDir, /^()[a-z0-9]+-[0-9a-f]{6}\.(in|out)\.json$/i)
  const events = trimEvents(1000)
  return { removed, events_trimmed: events, live: [...live] }
}

// Environment checks for the worker tools; each { check, ok, detail }.
export async function doctor() {
  const out = []
  const add = (check, ok, detail) => out.push({ check, ok, detail })
  const major = Number(process.versions.node.split('.')[0])
  add('node >= 24', major >= 24, process.version)
  add('platform', ['win32', 'darwin', 'linux'].includes(process.platform), `${process.platform} ${process.arch}${process.platform === 'win32' ? '' : ' (visible windows are Windows-only; runs are hidden)'}`)
  for (const mod of ['@lydell/node-pty', '@xterm/headless', '@modelcontextprotocol/sdk/server/mcp.js']) {
    try { await import(mod); add(`loads ${mod}`, true, '') } catch (e) { add(`loads ${mod}`, false, `${e.message.split('\n')[0]} — run npm ci in ${root}`) }
  }
  const run = (cmd, args) => { const [f, a] = resolveCommand(cmd, args); return execFileSync(f, a, { encoding: 'utf8', env: childEnv(), windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  try { add('claude CLI', true, `${resolveCommand('claude', [])[0]}: ${run('claude', ['--version'])}`) } catch (e) { add('claude CLI', false, `not runnable: ${e.message.split('\n')[0]} — install Claude Code and put claude on PATH`) }
  try { add('git (worktrees)', true, run('git', ['--version'])) } catch { add('git (worktrees)', false, 'git not on PATH: worktree option unavailable') }
  try {
    fs.mkdirSync(sessionDir, { recursive: true })
    const probe = path.join(sessionDir, `.probe-${process.pid}`)
    fs.writeFileSync(probe, 'x'); fs.rmSync(probe)
    add('state folder writable', true, sessionDir)
  } catch (e) { add('state folder writable', false, `${sessionDir}: ${e.message}`) }
  let stale = 0
  try { for (const f of fs.readdirSync(sessionDir)) if (/^[a-z0-9-]+\.json$/i.test(f) && f !== 'queue.json') { const s = readSession(f.slice(0, -5)); if (!s || !pidAlive(s.pid)) stale++ } } catch {}
  add('no stale sessions', stale === 0, stale ? `${stale} stale session file(s): run cc_cleanup` : '')
  const dialog = process.platform === 'win32' ? 'powershell.exe' : process.platform === 'darwin' ? 'osascript' : 'zenity'
  let hasDialog = true
  try { execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [dialog], { stdio: 'ignore', windowsHide: true }) } catch { hasDialog = false }
  add('ask dialog (cc_ask_user)', hasDialog, hasDialog ? dialog : `${dialog} not found: cc_ask_user returns "no answer" at once`)
  return out
}
