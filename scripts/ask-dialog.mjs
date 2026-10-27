// Shows one timed question dialog (lib/ask.mjs) and writes the answer to asks/<id>.out.json.
// Windows: WinForms via ask-dialog.ps1; macOS: osascript; Linux: zenity. No dialog → answered false.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { asksDir } from '../lib/ask.mjs'

const id = process.argv[2]
const inFile = path.join(asksDir, `${id}.in.json`)
const outFile = path.join(asksDir, `${id}.out.json`)
const ask = JSON.parse(fs.readFileSync(inFile, 'utf8'))
const timeoutSec = ask.timeoutSec
const write = (r) => { if (!fs.existsSync(outFile)) fs.writeFileSync(outFile, JSON.stringify(r)) }

// Run a dialog command; kill it a few seconds after the timeout in case it ignores its own.
function run(file, args) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    const kill = setTimeout(() => { try { child.kill() } catch {} }, (timeoutSec + 5) * 1000)
    child.on('error', (e) => { clearTimeout(kill); resolve({ code: -1, out, error: e.message }) })
    child.on('close', (code) => { clearTimeout(kill); resolve({ code, out: out.trim() }) })
  })
}

const has = (cmd) => spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [cmd], { stdio: 'ignore' }).status === 0
const answer = (choice) => (ask.options.includes(choice) ? { answered: true, choice } : { answered: true, text: choice })

try {
  if (process.platform === 'win32') {
    const ps1 = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ask-dialog.ps1')
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-InFile', inFile, '-OutFile', outFile])
    if (r.code !== 0 && !fs.existsSync(outFile)) write({ answered: false, error: `dialog failed (exit ${r.code}) ${r.error ?? ''}`.trim() })
  } else if (process.platform === 'darwin') {
    // Up to 3 options fit as buttons; otherwise a numbered list with a text field.
    const buttons = ask.options.length >= 1 && ask.options.length <= 3
    const prompt = buttons ? ask.question : `${ask.question}\n\n${ask.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}`
    const script = buttons
      ? ['on run argv', 'set r to display dialog (item 1 of argv) buttons (items 3 thru -1 of argv) giving up after ((item 2 of argv) as integer) with title "Claude needs your answer"', 'if gave up of r then return "__TIMEOUT__"', 'return button returned of r', 'end run']
      : ['on run argv', 'set r to display dialog (item 1 of argv) default answer "" buttons {"Send"} default button 1 giving up after ((item 2 of argv) as integer) with title "Claude needs your answer"', 'if gave up of r then return "__TIMEOUT__"', 'return text returned of r', 'end run']
    const r = await run('osascript', [...script.flatMap((l) => ['-e', l]), prompt, String(timeoutSec), ...(buttons ? ask.options : [])])
    let out = r.out
    if (!buttons && /^\d+$/.test(out) && ask.options[Number(out) - 1]) out = ask.options[Number(out) - 1]
    write(r.code !== 0 || !out || out === '__TIMEOUT__' ? { answered: false, timed_out: out === '__TIMEOUT__' || r.code === null } : answer(out))
  } else if (has('zenity')) {
    const args = ask.options.length
      ? ['--list', '--title=Claude needs your answer', `--text=${ask.question}`, '--column=Answer', ...ask.options, `--timeout=${timeoutSec}`]
      : ['--entry', '--title=Claude needs your answer', `--text=${ask.question}`, `--timeout=${timeoutSec}`]
    const r = await run('zenity', args)
    write(r.code === 0 && r.out ? answer(r.out) : { answered: false, timed_out: r.code === 5 })
  } else {
    write({ answered: false, error: 'no dialog available (install zenity)' })
  }
} catch (e) {
  write({ answered: false, error: e.message })
}
// The dialog may have been killed before it could write its own result.
write({ answered: false, timed_out: true })
try { fs.unlinkSync(inFile) } catch {}
