import fs from 'node:fs'
import path from 'node:path'
import { sessionDir } from './session.mjs'

// Task queue for the boss: tasks start as workers when their dependencies are done and fewer than
// max_parallel are active. Kept in queue.json so cc_queue_list survives an MCP server restart; the
// scheduler itself runs inside the MCP server (the boss session).
// Task: { id, name, prompt, depends_on: [ids], worker: { cc_start options }, state, error?, added, started?, finished? }
// state: pending → starting → running ⇄ needs_input → done | failed | blocked | cancelled
export const queueFile = path.join(sessionDir, 'queue.json')
export const FINAL = new Set(['done', 'failed', 'blocked', 'cancelled'])
const ACTIVE = new Set(['starting', 'running', 'needs_input'])

export function loadQueue() {
  try { return JSON.parse(fs.readFileSync(queueFile, 'utf8')) } catch { return { max_parallel: 3, tasks: [] } }
}

export function saveQueue(q) {
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(queueFile, JSON.stringify(q, null, 2))
}

// Add tasks; ids must be new and dependencies must name known tasks.
export function addTasks(tasks, maxParallel) {
  const q = loadQueue()
  if (maxParallel) q.max_parallel = maxParallel
  const ids = new Set(q.tasks.map((t) => t.id))
  for (const t of tasks) {
    if (ids.has(t.id)) throw new Error(`task id already queued: ${t.id}`)
    ids.add(t.id)
  }
  for (const t of tasks) for (const d of t.depends_on ?? []) if (!ids.has(d)) throw new Error(`task ${t.id} depends on unknown task ${d}`)
  const added = tasks.map((t) => ({ ...t, depends_on: t.depends_on ?? [], state: 'pending', added: new Date().toISOString() }))
  q.tasks.push(...added)
  saveQueue(q)
  return added
}

let ticking = false

// One scheduler pass. start(task) starts the worker and sends its prompt; status(name) returns the
// bridge /status (throws when the run is gone).
export async function tick({ start, status }) {
  if (ticking) return
  ticking = true
  try {
    const q = loadQueue()
    let changed = false
    const set = (t, state, extra = {}) => { Object.assign(t, { state, ...extra }); changed = true }
    const byId = new Map(q.tasks.map((t) => [t.id, t]))
    // A task left in "starting" by a server that died mid-start is checked like a running one.
    const settled = (x) => x.state !== 'starting' || Date.now() - Date.parse(x.started) > 120000
    for (const t of q.tasks.filter((x) => ACTIVE.has(x.state) && settled(x))) {
      let s
      try { s = await status(t.name) } catch { set(t, 'failed', { error: 'worker is gone', finished: new Date().toISOString() }); continue }
      const next = s.state === 'done' ? 'done' : s.state === 'exited' ? 'failed' : ['question', 'permission'].includes(s.state) ? 'needs_input' : 'running'
      if (next !== t.state) set(t, next, FINAL.has(next) ? { finished: new Date().toISOString(), ...(next === 'failed' ? { error: `worker exited (code ${s.exitCode})` } : {}) } : {})
    }
    for (const t of q.tasks.filter((x) => x.state === 'pending')) {
      const deps = t.depends_on.map((d) => byId.get(d))
      const bad = deps.find((d) => ['failed', 'blocked', 'cancelled'].includes(d?.state))
      if (bad) { set(t, 'blocked', { error: `dependency ${bad.id} ${bad.state}` }); continue }
      if (!deps.every((d) => d.state === 'done')) continue
      if (q.tasks.filter((x) => ACTIVE.has(x.state)).length >= q.max_parallel) break
      set(t, 'starting', { started: new Date().toISOString() })
      saveQueue(q)
      try { await start(t); t.state = 'running' } catch (e) { set(t, 'failed', { error: String(e.message || e), finished: new Date().toISOString() }) }
    }
    if (changed) saveQueue(q)
    return q
  } finally { ticking = false }
}
