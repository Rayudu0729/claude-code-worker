import fs from 'node:fs'
import { readSession, removeSession, sessionDir, validName, pidAlive } from './session.mjs'

export class NotRunning extends Error {
  constructor(name) { super(`not running: ${name}`); this.code = 'not_running' }
}

export class HttpError extends Error {
  constructor(status, msg) { super(`${status} ${msg ?? ''}`.trim()); this.status = status }
}

export async function call(name, method, path, body) {
  if (!validName(name)) throw new Error(`invalid session name: ${name}`)
  const session = readSession(name)
  if (!session) throw new NotRunning(name)
  let res
  try {
    res = await fetch(`http://127.0.0.1:${session.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (e) {
    if (e.cause?.code === 'ECONNREFUSED') { removeSession(name); throw new NotRunning(name) }
    throw e
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new HttpError(res.status, data.error)
  return data
}

export function listSessions() {
  let files = []
  try { files = fs.readdirSync(sessionDir).filter((f) => /^[a-z0-9-]+\.json$/i.test(f)) } catch {}
  const out = []
  for (const f of files) {
    const s = readSession(f.slice(0, -5))
    if (!s) continue
    if (!pidAlive(s.pid)) { removeSession(s.name); continue }
    out.push({ name: s.name, pid: s.pid, command: s.command, cwd: s.cwd, started: s.started })
  }
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Claude Code shows "esc to interrupt" in its status line for as long as a turn is running.
export const WORKING = /esc to interrupt/i

// Poll the screen until it is unchanged for idleSec, matches the regex, or (done) the claude turn has
// ended: no "esc to interrupt" and the screen steady for 2 s. Resolves { met, exited, timedOut, text }.
export async function waitFor(name, { idleSec, match, done, timeoutSec = 600 }) {
  const re = match ? new RegExp(match, 'm') : null
  const idleMs = idleSec ? idleSec * 1000 : 0
  const deadline = Date.now() + timeoutSec * 1000
  let last = null
  let stableSince = Date.now()
  for (;;) {
    const s = await call(name, 'GET', '/screen')
    if (s.text !== last) { last = s.text; stableSince = Date.now() }
    const steady = Date.now() - stableSince
    const met = Boolean((re && re.test(s.text)) || (idleMs && steady >= idleMs) || (done && !WORKING.test(s.text) && steady >= 2000))
    if (met || s.exited) return { met, exited: s.exited, timedOut: false, text: s.text }
    if (Date.now() > deadline) return { met: false, exited: false, timedOut: true, text: s.text }
    await sleep(500)
  }
}
