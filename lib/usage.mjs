import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const projectsDir = path.join(os.homedir(), '.claude', 'projects')

// The transcript of a claude run started with --session-id <id> is ~/.claude/projects/<cwd slug>/<id>.jsonl.
// Search instead of rebuilding the slug, so a worker that changed directory is still found.
export function findTranscript(sessionId) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId ?? '')) return null
  let dirs = []
  try { dirs = fs.readdirSync(projectsDir) } catch { return null }
  for (const d of dirs) {
    const f = path.join(projectsDir, d, `${sessionId}.jsonl`)
    if (fs.existsSync(f)) return f
  }
  return null
}

// Token usage of one claude session, read incrementally from its transcript. A message can be written
// once per content block with the same usage, so each message id is counted once.
export class UsageTracker {
  constructor(sessionId) {
    this.sessionId = sessionId
    this.file = null
    this.offset = 0
    this.rest = ''
    this.seen = new Set()
    this.totals = { input: 0, cache_creation: 0, cache_read: 0, output: 0, context: 0, messages: 0, model: null }
  }

  read() {
    this.file ??= findTranscript(this.sessionId)
    if (!this.file) return this.summary()
    let fd
    try {
      fd = fs.openSync(this.file, 'r')
      const size = fs.fstatSync(fd).size
      if (size > this.offset) {
        const buf = Buffer.alloc(size - this.offset)
        fs.readSync(fd, buf, 0, buf.length, this.offset)
        this.offset = size
        const lines = (this.rest + buf.toString('utf8')).split('\n')
        this.rest = lines.pop()
        for (const line of lines) this.add(line)
      }
    } catch {} finally { if (fd !== undefined) fs.closeSync(fd) }
    return this.summary()
  }

  add(line) {
    if (!line.includes('"usage"')) return
    let m
    try { m = JSON.parse(line).message } catch { return }
    const u = m?.usage
    if (!u || (m.id && this.seen.has(m.id))) return
    if (m.id) this.seen.add(m.id)
    const t = this.totals
    t.input += u.input_tokens ?? 0
    t.cache_creation += u.cache_creation_input_tokens ?? 0
    t.cache_read += u.cache_read_input_tokens ?? 0
    t.output += u.output_tokens ?? 0
    t.context = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
    t.messages++
    t.model = m.model ?? t.model
  }

  // tokens = new input + cache writes + output; cache reads are listed apart (they are cheap and repeat every turn).
  summary() {
    const t = this.totals
    return { session_id: this.sessionId, tokens: t.input + t.cache_creation + t.output, ...t }
  }
}
