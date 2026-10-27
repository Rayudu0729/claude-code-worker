import fs from 'node:fs'
import path from 'node:path'
import { sessionDir } from './session.mjs'

// Worker state changes, one JSON line each: { t, name, kind, ... }. Every bridge appends; the boss
// blocks on them (cc_wait_any / cc-ctl wait-any) instead of polling each worker.
// kind: done | question | permission | exited | restarted | over_budget
export const eventsFile = path.join(sessionDir, 'events.jsonl')

export function emit(name, kind, extra = {}) {
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.appendFileSync(eventsFile, JSON.stringify({ t: Date.now(), name, kind, ...extra }) + '\n')
}

// Events after time `since` (ms), optionally only for some names (case-insensitive).
export function readEvents(since = 0, names = []) {
  let text = ''
  try { text = fs.readFileSync(eventsFile, 'utf8') } catch { return [] }
  const want = new Set(names.map((n) => n.toLowerCase()))
  const out = []
  for (const line of text.split('\n')) {
    if (!line) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.t > since && (!want.size || want.has(String(e.name).toLowerCase()))) out.push(e)
  }
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Block until at least one event after `since` arrives. Resolves { events, cursor, timedOut }; pass
// cursor as the next `since` so nothing is missed between calls.
export async function waitAny({ since = Date.now(), names = [], timeoutSec = 600 } = {}) {
  const deadline = Date.now() + timeoutSec * 1000
  for (;;) {
    const events = readEvents(since, names)
    if (events.length) return { events, cursor: events.at(-1).t, timedOut: false }
    if (Date.now() > deadline) return { events: [], cursor: since, timedOut: true }
    await sleep(500)
  }
}

// Keep the last `keep` lines.
export function trimEvents(keep = 1000) {
  try {
    const lines = fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean)
    if (lines.length > keep) fs.writeFileSync(eventsFile, lines.slice(-keep).join('\n') + '\n')
    return Math.max(0, lines.length - keep)
  } catch { return 0 }
}
