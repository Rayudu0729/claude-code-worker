import { validName } from './lib/session.mjs'
import { call as rawCall, waitFor, NotRunning } from './lib/client.mjs'

const USAGE = `usage:
  cc-ctl screen <name> [--scrollback N]
  cc-ctl send <name> <text> [--enter]
  cc-ctl key <name> <Enter|Esc|Tab|ShiftTab|Up|Down|Left|Right|Backspace|CtrlC> [--repeat N]
  cc-ctl wait <name> (--done | --idle <sec> | --match <regex>) [--timeout <sec>] [--quiet]
  cc-ctl status <name>
  cc-ctl stop <name>`

function fail(msg, code = 1) {
  console.error(msg)
  process.exit(code)
}

const [cmd, name, ...rest] = process.argv.slice(2)
if (!cmd || !name) fail(USAGE)
if (!validName(name)) fail(`invalid session name: ${name}`)

function flag(flagName) {
  const i = rest.indexOf(flagName)
  return i >= 0 ? rest[i + 1] : undefined
}
const has = (flagName) => rest.includes(flagName)

async function call(method, path, body) {
  try { return await rawCall(name, method, path, body) } catch (e) {
    if (e instanceof NotRunning) fail(e.message, 3)
    fail(`cc-ctl: ${e.message}`)
  }
}

switch (cmd) {
  case 'screen': {
    const s = await call('GET', `/screen?scrollback=${parseInt(flag('--scrollback') || '0', 10) || 0}`)
    console.log(s.text)
    break
  }
  case 'send': {
    const text = rest[0] === '--enter' ? '' : (rest[0] ?? '')
    await call('POST', '/send', { text, enter: has('--enter') })
    break
  }
  case 'key': {
    const key = rest[0]
    if (!key) fail(USAGE)
    await call('POST', '/key', { key, repeat: parseInt(flag('--repeat') || '1', 10) })
    break
  }
  case 'wait': {
    const idle = flag('--idle')
    const match = flag('--match')
    const done = has('--done')
    if (!done && !idle && !match) fail(USAGE)
    const timeoutSec = parseFloat(flag('--timeout') || '600') || 600
    let r
    try { r = await waitFor(name, { done, idleSec: idle ? parseFloat(idle) : 0, match, timeoutSec }) } catch (e) {
      if (e instanceof NotRunning) fail(e.message, 3)
      fail(`cc-ctl: ${e.message}`)
    }
    // --quiet prints one line instead of the screen (for a boss waiting in the background).
    console.log(has('--quiet') ? `${name}: ${r.met ? 'done' : r.exited ? 'exited' : 'timed out'}` : r.text)
    if (r.timedOut) fail(`cc-ctl: wait timed out after ${timeoutSec}s`, 2)
    process.exit(r.met ? 0 : 4)
  }
  case 'status': {
    console.log(JSON.stringify(await call('GET', '/status'), null, 2))
    break
  }
  case 'stop': {
    await call('POST', '/stop')
    break
  }
  default:
    fail(USAGE)
}
