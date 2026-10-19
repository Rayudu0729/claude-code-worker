import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import ptyMod from '@lydell/node-pty'
import xtermMod from '@xterm/headless'
import { validName, readSession, writeSession, removeSession, pidAlive } from './lib/session.mjs'
import { KEYS } from './lib/keys.mjs'
import { resolveCommand } from './lib/command.mjs'

const pty = ptyMod.default ?? ptyMod
const { Terminal } = xtermMod.default ?? xtermMod

function usage(msg) {
  if (msg) console.error(msg)
  console.error('usage: cc-bridge start <name> [--spec <file.json>] [-- <command> [args...]]')
  process.exit(1)
}

const argv = process.argv.slice(2)
if (argv[0] !== 'start') usage()
const name = argv[1]
if (!validName(name)) usage(`invalid name "${name ?? ''}": use letters, digits and dashes, max 32`)
// --spec <file>: { command: [...], cols, rows } written by the MCP server; read once, then deleted.
let spec = {}
const specAt = argv.indexOf('--spec')
if (specAt >= 0) {
  const specFile = argv[specAt + 1]
  try { spec = JSON.parse(fs.readFileSync(specFile, 'utf8')) } catch (e) { usage(`cannot read spec: ${e.message}`) }
  try { fs.unlinkSync(specFile) } catch {}
}
const dash = argv.indexOf('--')
const userCmd = spec.command ?? (dash >= 0 ? argv.slice(dash + 1) : ['claude', ...argv.slice(2)])
if (userCmd.length === 0) usage('no command after --')

const existing = readSession(name)
if (existing && pidAlive(existing.pid)) {
  console.error(`cc-bridge: session "${name}" is already running (pid ${existing.pid})`)
  process.exit(1)
}
removeSession(name)

const [file, fileArgs] = resolveCommand(userCmd[0], userCmd.slice(1))
const cols = process.stdout.columns || spec.cols || 120
const rows = process.stdout.rows || spec.rows || 30
const term = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true })
const child = pty.spawn(file, fileArgs, { name: 'xterm-256color', cols, rows, cwd: process.cwd(), env: process.env })

let lastOutputAt = Date.now()
let bracketedPaste = false
let exited = false
let exitCode = null

child.onData((d) => {
  process.stdout.write(d)
  term.write(d)
  lastOutputAt = Date.now()
  const on = d.lastIndexOf('\x1b[?2004h'), off = d.lastIndexOf('\x1b[?2004l')
  if (on !== off) bracketedPaste = on > off
})

if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on('data', (d) => { if (!exited) child.write(d.toString('utf8')) })
process.stdin.resume()

process.stdout.on('resize', () => {
  const c = process.stdout.columns, r = process.stdout.rows
  if (!c || !r || exited) return
  child.resize(c, r)
  term.resize(c, r)
})

// Marker on the buffer line where the cursor was at the last /send. xterm moves it as scrollback is
// trimmed, so "since send" keeps pointing at the same output.
let sendMarker = null

function screen(scrollback, sinceSend) {
  const b = term.buffer.active
  const alt = b.type === 'alternate'
  const end = b.viewportY + term.rows
  let start = Math.max(0, b.viewportY - scrollback)
  let sinceSendOk = false
  if (sinceSend && !alt && sendMarker && !sendMarker.isDisposed) {
    start = Math.max(0, Math.min(sendMarker.line, end - 1), end - 2000)
    sinceSendOk = true
  }
  const lines = []
  for (let i = start; i < end; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '')
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return { text: lines.join('\n'), cursor: { x: b.cursorX, y: b.cursorY }, cols: term.cols, rows: term.rows, lastOutputAt, exited, altScreen: alt, sinceSend: sinceSendOk }
}

const token = crypto.randomBytes(32).toString('hex')
const tokenBuf = Buffer.from(`Bearer ${token}`)

function authorized(req) {
  const h = Buffer.from(String(req.headers.authorization || ''))
  return h.length === tokenBuf.length && crypto.timingSafeEqual(h, tokenBuf)
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 65536) { reject(new Error('body too large')); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error('invalid JSON')) }
    })
    req.on('error', reject)
  })
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const ESC = String.fromCharCode(27)

async function typeText(text) {
  const body = bracketedPaste && (text.length > 80 || text.includes(String.fromCharCode(10))) ? ESC + '[200~' + text + ESC + '[201~' : text
  for (let i = 0; i < body.length; i += 256) {
    child.write(body.slice(i, i + 256))
    if (i + 256 < body.length) await wait(10)
  }
}

function stopChild() {
  if (exited) return
  child.write(KEYS.CtrlC)
  setTimeout(() => { if (!exited) child.write(KEYS.CtrlC) }, 300)
  setTimeout(() => { if (!exited) try { child.kill() } catch {} }, 3000)
}

const server = http.createServer(async (req, res) => {
  if (!authorized(req)) return send(res, 401, { error: 'unauthorized' })
  const url = new URL(req.url, 'http://127.0.0.1')
  try {
    if (req.method === 'GET' && url.pathname === '/screen') {
      const n = Math.min(Math.max(parseInt(url.searchParams.get('scrollback') || '0', 10) || 0, 0), 2000)
      return send(res, 200, screen(n, url.searchParams.get('since') === 'send'))
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      return send(res, 200, { name, pid: process.pid, childPid: child.pid, running: !exited, exitCode, cols: term.cols, rows: term.rows, lastOutputAt, altScreen: term.buffer.active.type === 'alternate', bracketedPaste })
    }
    if (req.method === 'POST' && url.pathname === '/send') {
      const { text, enter } = await readBody(req)
      if (typeof text !== 'string') return send(res, 400, { error: 'text must be a string' })
      if (exited) return send(res, 409, { error: 'process has exited' })
      sendMarker?.dispose()
      sendMarker = term.buffer.active.type === 'normal' ? term.registerMarker(0) : null
      if (text) await typeText(text)
      if (enter) { await wait(text ? (text.length > 200 ? 400 : 150) : 0); child.write(KEYS.Enter) }
      return send(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/key') {
      const { key, repeat } = await readBody(req)
      if (!Object.hasOwn(KEYS, key)) return send(res, 400, { error: `unknown key; valid: ${Object.keys(KEYS).join(' ')}` })
      if (exited) return send(res, 409, { error: 'process has exited' })
      const times = Math.min(Math.max(parseInt(repeat, 10) || 1, 1), 50)
      for (let i = 0; i < times; i++) { child.write(KEYS[key]); if (i < times - 1) await wait(40) }
      return send(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/stop') {
      stopChild()
      return send(res, 200, { ok: true })
    }
    return send(res, 404, { error: 'not found' })
  } catch (e) {
    return send(res, 400, { error: e.message })
  }
})

server.listen(0, '127.0.0.1', () => {
  writeSession(name, { name, port: server.address().port, token, pid: process.pid, command: spec.display ?? userCmd.join(' '), cwd: process.cwd(), started: new Date().toISOString() })
})

let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  removeSession(name)
  server.close()
  if (process.stdin.isTTY) try { process.stdin.setRawMode(false) } catch {}
}

child.onExit(({ exitCode: code }) => {
  exited = true
  exitCode = code
  cleanup()
  process.stdout.write(`\r\n[cc-bridge] "${name}" exited with code ${code}\r\n`)
  setTimeout(() => process.exit(code ?? 0), 50)
})

process.on('exit', () => { removeSession(name) })
process.on('SIGTERM', () => { stopChild() })
process.on('uncaughtException', (e) => {
  console.error(`[cc-bridge] ${e.stack || e}`)
  try { child.kill() } catch {}
  cleanup()
  process.exit(1)
})
