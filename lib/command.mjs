import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// Resolve a bare command name through where.exe so .cmd shims (like claude.cmd) can be spawned.
export function resolveCommand(cmd, args) {
  if (process.platform !== 'win32' || path.isAbsolute(cmd) || /[\\/]/.test(cmd)) return [cmd, args]
  let found = cmd
  if (!path.extname(cmd)) {
    try {
      const hits = execFileSync('where.exe', [cmd], { encoding: 'utf8', env: childEnv(), windowsHide: true }).split(/\r?\n/).filter(Boolean)
      found = hits.find((h) => /\.(exe|cmd|bat|com)$/i.test(h)) || hits[0] || cmd
    } catch { found = cmd }
  }
  if (/\.(cmd|bat)$/i.test(found)) {
    const exe = shimTarget(found)
    if (exe) return [exe, args]
    return [process.env.ComSpec || 'cmd.exe', ['/d', '/c', found, ...args]]
  }
  return [found, args]
}

// npm shims end in `"%dp0%\node_modules\...\claude.exe" %*`. Running that .exe directly keeps
// arguments away from cmd.exe, which would otherwise interpret & | < > in them.
function shimTarget(cmdFile) {
  try {
    const m = fs.readFileSync(cmdFile, 'utf8').match(/"%dp0%\\([^"]+\.exe)"/i)
    if (!m) return null
    const exe = path.join(path.dirname(cmdFile), m[1])
    return fs.existsSync(exe) ? exe : null
  } catch { return null }
}

// Variables a host Claude session (CLI or desktop app) sets for its children. A claude run started
// from the MCP server must not inherit them, or it behaves as a child of that session (no transcript,
// host auth, host messaging socket). Variables the user set in their own Windows environment are kept.
const HOST_VARS = /^(CLAUDECODE|CLAUDE_CODE_.+|CLAUDE_AGENT_SDK_.+|CLAUDE_PID|CLAUDE_PREVIEW_.+|ANTHROPIC_BASE_URL|MCP_CONNECTION_NONBLOCKING|MCP_SERVER_CONNECTION_BATCH_SIZE)$/i

let persistent
function persistentVarNames() {
  if (persistent) return persistent
  persistent = new Set()
  if (process.platform !== 'win32') return persistent
  for (const key of ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']) {
    try {
      const out = execFileSync('reg.exe', ['query', key], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      for (const m of out.matchAll(/^\s{4}(\S+)\s{4}REG_/gm)) persistent.add(m[1].toUpperCase())
    } catch {}
  }
  return persistent
}

export function childEnv() {
  const env = {}
  const keep = persistentVarNames()
  for (const [k, v] of Object.entries(process.env)) if (!HOST_VARS.test(k) || keep.has(k.toUpperCase())) env[k] = v
  // MCP clients may start this server with a trimmed environment; where.exe needs PATHEXT to find
  // `powershell` or `claude` without an extension.
  if (process.platform === 'win32' && !Object.keys(env).some((k) => /^PATHEXT$/i.test(k))) env.PATHEXT = '.COM;.EXE;.BAT;.CMD'
  return env
}
