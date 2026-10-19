// Installs the plugin's node dependencies when node_modules is missing or older than package-lock.json.
// Used by the SessionStart hook and by mcp-launch.mjs (which can start before the hook finishes).
// Uses only Node built-ins. Writes nothing to stdout: hook stdout becomes session context and
// MCP stdout is the protocol channel.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stamp = path.join(root, 'node_modules', '.claude-code-worker-stamp')
const lockDir = path.join(root, '.deps-installing')
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function lockHash() {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'package-lock.json'))).digest('hex')
}

const upToDate = () => { try { return fs.readFileSync(stamp, 'utf8') === lockHash() } catch { return false } }

export function ensureDeps() {
  if (upToDate()) return
  // One installer at a time: the hook and the MCP launcher may both get here.
  for (let waited = 0; ; waited += 500) {
    try { fs.mkdirSync(lockDir); break } catch {
      if (upToDate()) return
      const age = Date.now() - (fs.statSync(lockDir, { throwIfNoEntry: false })?.mtimeMs ?? 0)
      if (age > 300000) { fs.rmSync(lockDir, { recursive: true, force: true }); continue }
      if (waited > 300000) throw new Error('claude-code-worker: timed out waiting for another dependency install')
      sleep(500)
    }
  }
  try {
    if (upToDate()) return
    process.stderr.write('claude-code-worker: installing node dependencies (npm ci)...\n')
    // npm is a .cmd shim on Windows, so it has to go through cmd.exe; the command line is fixed.
    const npmCi = 'npm ci --omit=dev --no-audit --no-fund'
    const [file, args] = process.platform === 'win32'
      ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', npmCi]]
      : ['npm', npmCi.split(' ').slice(1)]
    const r = spawnSync(file, args, { cwd: root, encoding: 'utf8', windowsHide: true })
    if (r.status !== 0) throw new Error(`claude-code-worker: npm ci failed (exit ${r.status})\n${(r.stderr || r.stdout || r.error?.message || '').slice(-2000)}`)
    fs.writeFileSync(stamp, lockHash())
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { ensureDeps() } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1) }
}
