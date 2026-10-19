import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSession, sessionPath } from './lib/session.mjs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const name = `smoke-${process.pid}`
const ctl = (...a) => execFileSync(process.execPath, [path.join(dir, 'cc-ctl.mjs'), ...a], { encoding: 'utf8' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (ok, msg) => { if (!ok) throw new Error(`FAIL: ${msg}`); console.log(`ok - ${msg}`) }

const bridge = spawn(process.execPath, [path.join(dir, 'cc-bridge.mjs'), 'start', name, '--', 'powershell', '-NoLogo', '-NoProfile'], { stdio: ['pipe', 'ignore', 'inherit'] })
try {
  for (let i = 0; i < 40 && !readSession(name); i++) await sleep(250)
  const s = readSession(name)
  check(s && s.port > 0 && /^[0-9a-f]{64}$/.test(s.token), 'session file written with port and token')

  ctl('wait', name, '--match', 'PS .*>', '--timeout', '30')
  ctl('send', name, 'echo "hi-$(2+3)"', '--enter')
  const out = ctl('wait', name, '--match', '^hi-5\\s*$', '--timeout', '20')
  check(/^hi-5\s*$/m.test(out), 'sent command ran and screen shows its output')

  const bad = await fetch(`http://127.0.0.1:${s.port}/screen`, { headers: { authorization: 'Bearer nope' } })
  check(bad.status === 401, 'bad token gets 401')

  const st = JSON.parse(ctl('status', name))
  check(st.running === true, 'status reports running')

  ctl('send', name, 'exit', '--enter')
  for (let i = 0; i < 40 && fs.existsSync(sessionPath(name)); i++) await sleep(250)
  check(!fs.existsSync(sessionPath(name)), 'session file removed after the child exits')

  let code = 0
  try { ctl('status', name) } catch (e) { code = e.status }
  check(code === 3, 'cc-ctl reports not running with exit 3')
  console.log('PASS')
} catch (e) {
  console.error(e.message)
  process.exitCode = 1
} finally {
  bridge.kill()
}
