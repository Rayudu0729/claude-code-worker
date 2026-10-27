import { validName } from './lib/session.mjs'
import { call as rawCall, waitFor, listSessions, NotRunning } from './lib/client.mjs'
import { waitAny } from './lib/events.mjs'
import { startAsk, waitAsk } from './lib/ask.mjs'
import { cleanup, doctor } from './lib/maint.mjs'

const USAGE = `usage:
  cc-ctl screen <name> [--scrollback N]
  cc-ctl send <name> <text> [--enter]
  cc-ctl key <name> <Enter|Esc|Tab|ShiftTab|Up|Down|Left|Right|Backspace|CtrlC> [--repeat N]
  cc-ctl wait <name> (--done | --idle <sec> | --match <regex>) [--timeout <sec>] [--quiet]
  cc-ctl status <name>
  cc-ctl stop <name>
  cc-ctl list
  cc-ctl wait-any [names...] [--since <ms>] [--timeout <sec>] [--quiet]
  cc-ctl ask "<question>" [--option <text>]... [--recommended <text>] [--timeout <sec>]
  cc-ctl doctor
  cc-ctl cleanup [--days N]`

function fail(msg, code = 1) {
  console.error(msg)
  process.exit(code)
}

const argv = process.argv.slice(2)
const flagOf = (args, flagName) => { const i = args.indexOf(flagName); return i >= 0 ? args[i + 1] : undefined }
const allOf = (args, flagName) => args.flatMap((a, i) => (a === flagName && i + 1 < args.length ? [args[i + 1]] : []))

// Commands that do not act on one run.
switch (argv[0]) {
  case 'list': {
    console.log(JSON.stringify(listSessions().map(({ command, ...s }) => s), null, 2))
    process.exit(0)
  }
  case 'wait-any': {
    // Blocks until a worker changes state; prints "<name>: <kind>" per event and "cursor <ms>" for --since next time.
    const args = argv.slice(1)
    const names = args.filter((a, i) => !a.startsWith('--') && !['--since', '--timeout'].includes(args[i - 1]))
    for (const n of names) if (!validName(n)) fail(`invalid session name: ${n}`)
    const timeoutSec = parseFloat(flagOf(args, '--timeout') || '600') || 600
    const since = flagOf(args, '--since') ? Number(flagOf(args, '--since')) : Date.now()
    const r = await waitAny({ since, names, timeoutSec })
    if (r.timedOut) fail(`cc-ctl: wait-any timed out after ${timeoutSec}s`, 2)
    for (const e of r.events) console.log(args.includes('--quiet') ? `${e.name}: ${e.kind}` : JSON.stringify(e))
    console.log(`cursor ${r.cursor}`)
    process.exit(0)
  }
  case 'ask': {
    // Shows a timed dialog and prints the result JSON; exit 0 answered, 5 no answer.
    const args = argv.slice(1)
    const question = args[0]
    if (!question || question.startsWith('--')) fail(USAGE)
    const timeoutSec = parseInt(flagOf(args, '--timeout') || '120', 10) || 120
    const id = startAsk({ question, options: allOf(args, '--option'), recommended: flagOf(args, '--recommended'), timeoutSec })
    const r = await waitAsk(id, timeoutSec + 15)
    console.log(JSON.stringify(r ?? { id, answered: false, timed_out: true }))
    process.exit(r?.answered ? 0 : 5)
  }
  case 'doctor': {
    const checks = await doctor()
    for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.check}${c.detail ? ` — ${c.detail}` : ''}`)
    process.exit(checks.every((c) => c.ok) ? 0 : 1)
  }
  case 'cleanup': {
    console.log(JSON.stringify(cleanup({ days: parseFloat(flagOf(argv, '--days') || '3') }), null, 2))
    process.exit(0)
  }
}

const [cmd, name, ...rest] = argv
if (!cmd || !name) fail(USAGE)
if (!validName(name)) fail(`invalid session name: ${name}`)

const flag = (flagName) => flagOf(rest, flagName)
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
