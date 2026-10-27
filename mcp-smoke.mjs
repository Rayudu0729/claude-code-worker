// End-to-end test of cc-mcp.mjs over stdio. Run: node mcp-smoke.mjs [--visible]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const visible = process.argv.includes('--visible')
const check = (ok, msg) => { if (!ok) throw new Error(`FAIL: ${msg}`); console.log(`ok - ${msg}`) }
const text = (r) => r.content.map((c) => c.text).join('\n')

const client = new Client({ name: 'mcp-smoke', version: '1.0.0' })
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(dir, 'cc-mcp.mjs')], stderr: 'inherit' }))
const tool = (name, args = {}) => client.callTool({ name, arguments: args })
const name = `msmoke-${process.pid}`
// PowerShell imitating a claude turn: the status-line text while "working", then a cleared screen with a report.
const FAKE_TURN = 'Write-Host "esc to interrupt"; Start-Sleep 3; Clear-Host; Write-Host "Worker report"'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mcp-'))

try {
  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name)
  check(['cc_start', 'cc_list', 'cc_screen', 'cc_send', 'cc_key', 'cc_wait', 'cc_status', 'cc_stop', 'cc_cli', 'cc_settings_get', 'cc_settings_set', 'cc_permission',
    'cc_roles', 'cc_wait_any', 'cc_report', 'cc_queue_add', 'cc_queue_list', 'cc_queue_cancel', 'cc_worktree', 'cc_ask_user', 'cc_ask_result', 'cc_doctor', 'cc_cleanup'].every((n) => names.includes(n)), `all tools listed (${names.length})`)

  const start = await tool('cc_start', { name, cwd: tmp, visible, command: ['powershell', '-NoLogo', '-NoProfile'] })
  check(!start.isError, `cc_start (${visible ? 'visible' : 'hidden'}): ${text(start).replace(/\s+/g, ' ')}`)
  check(text(await tool('cc_list')).includes(name), 'cc_list shows the run')

  check(!(await tool('cc_wait', { name, match: 'PS .*>', timeout: 30 })).isError, 'cc_wait sees the prompt')
  await tool('cc_send', { name, text: 'echo "mcp-$(3+4)"; (Get-Location).Path' })
  const w = await tool('cc_wait', { name, match: '^mcp-7\\s*$', timeout: 20 })
  check(!w.isError && text(w).includes(path.basename(tmp)), 'cc_send ran in the requested cwd')
  check(/last output/.test(text(await tool('cc_screen', { name }))), 'cc_screen returns the screen')

  await tool('cc_send', { name, text: '1..40 | % { "row-$_" }' })
  const ss = text(await tool('cc_wait', { name, done: true, since_send: true }))
  check(/since last send/.test(ss) && /^row-1\s*$/m.test(ss) && /^row-40\s*$/m.test(ss), 'cc_wait done + since_send returns output that scrolled off screen')
  const cap = text(await tool('cc_screen', { name, since_send: true, max_lines: 10 }))
  check(/earlier lines omitted/.test(cap) && !/^row-1\s*$/m.test(cap) && /^row-40\s*$/m.test(cap), 'since_send max_lines keeps only the last lines')
  await tool('cc_send', { name, text: 'echo "noise"; echo "Worker report"; echo "- files: a.txt"' })
  await tool('cc_wait', { name, match: '^- files: a.txt\\s*$', timeout: 20 })
  const waitCmd = JSON.parse(text(start)).wait_command

  check(/: done$/.test(execSync(waitCmd, { encoding: 'utf8' }).trim()), 'wait_command (cc-ctl wait --done --quiet) prints one line')
  const rep = text(await tool('cc_screen', { name, since_send: true }))
  check(/report only/.test(rep) && !/^noise\s*$/m.test(rep) && /^- files: a.txt\s*$/m.test(rep), 'since_send returns only the Worker report block')
  const to = await tool('cc_wait', { name, match: 'never-appears-xyz', timeout: 2 })
  check(to.isError && text(to).split('\n').filter(Boolean).length <= 2, 'cc_wait timeout returns only a status line')

  await tool('cc_send', { name, text: 'echo "ml-a"\necho "ml-b"' })
  const ml = text(await tool('cc_wait', { name, match: '^ml-b\\s*$', timeout: 20 }))
  check(/^ml-a\s*$/m.test(ml) && /^ml-b\s*$/m.test(ml), 'multi-line cc_send runs both lines')

  // A fake claude turn: "esc to interrupt" on screen, then cleared and a report printed → a done event.
  const since = Date.now()
  await tool('cc_send', { name, text: FAKE_TURN })
  const ev = JSON.parse(text(await tool('cc_wait_any', { names: [name], since, timeout: 40 })))
  check(ev.events.some((e) => e.name === name && e.kind === 'done') && ev.cursor > since, `cc_wait_any sees the done event (${ev.events.map((e) => e.kind).join(',')})`)
  check(JSON.parse(text(await tool('cc_list'))).find((s) => s.name === name)?.state === 'done', 'cc_list shows the worker state')

  check(JSON.parse(text(await tool('cc_status', { name }))).running === true, 'cc_status running')
  check(!(await tool('cc_key', { name, key: 'Enter' })).isError, 'cc_key Enter')

  const dup = await tool('cc_start', { name, command: ['powershell'] })
  check(dup.isError, 'duplicate start refused')

  check(/^stopped /.test(text(await tool('cc_stop', { name }))), 'cc_stop waits until the run is gone')
  check(!text(await tool('cc_list')).includes(name), 'cc_list no longer shows the run')
  check((await tool('cc_screen', { name })).isError, 'cc_screen on a stopped run is an error')

  // Worktrees: a worker in its own worktree on branch worker/<name>, then removed with its branch.
  const repo = path.join(tmp, 'repo')
  fs.mkdirSync(repo)
  const git = (...a) => execSync(`git -C "${repo}" ${a.join(' ')}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  const wname = `${name}-wt`
  const ws = JSON.parse(text(await tool('cc_start', { name: wname, cwd: repo, visible: false, worktree: true, command: ['powershell', '-NoLogo', '-NoProfile'] })))
  check(ws.branch === `worker/${wname}` && fs.existsSync(ws.worktree) && ws.cwd.toLowerCase() === ws.worktree.toLowerCase(), `cc_start worktree runs in ${ws.worktree}`)
  check((await tool('cc_worktree', { action: 'remove', cwd: repo, name: wname })).isError, 'cc_worktree refuses to remove a running worker\'s worktree')
  await tool('cc_stop', { name: wname })
  check(JSON.parse(text(await tool('cc_worktree', { action: 'list', cwd: repo }))).some((w) => w.name === wname), 'cc_worktree list shows it')
  const rm = await tool('cc_worktree', { action: 'remove', cwd: repo, name: wname, delete_branch: true })
  check(!rm.isError && !fs.existsSync(ws.worktree) && !git('branch').includes(`worker/${wname}`), 'cc_worktree remove deletes worktree and branch')

  // Queue: b waits for a; both finish (fake turns) and end as done.
  const qa = `${name}-qa`, qb = `${name}-qb`
  const cmd = ['powershell', '-NoLogo', '-NoProfile']
  const qadd = await tool('cc_queue_add', { tasks: [
    { id: qa, prompt: FAKE_TURN, cwd: tmp, visible: false, command: cmd },
    { id: qb, prompt: FAKE_TURN, cwd: tmp, visible: false, command: cmd, depends_on: [qa] },
  ] })
  check(!qadd.isError, `cc_queue_add: ${text(qadd).slice(0, 120).replace(/\s+/g, ' ')}`)
  let q
  for (let i = 0; i < 60; i++) {
    q = JSON.parse(text(await tool('cc_queue_list'))).tasks.filter((t) => [qa, qb].includes(t.id))
    if (q.every((t) => ['done', 'failed', 'blocked'].includes(t.state))) break
    if (i === 3) check(q.find((t) => t.id === qb).state === 'pending', 'dependent task waits while its dependency runs')
    await new Promise((r) => setTimeout(r, 1000))
  }
  check(q.every((t) => t.state === 'done'), `queued tasks finish in order (${q.map((t) => `${t.id}=${t.state}${t.error ? ` ${t.error}` : ''}`).join(', ')})`)
  for (const n of [qa, qb]) await tool('cc_stop', { name: n })
  await tool('cc_queue_cancel', { ids: [qa, qb], clear_finished: true })

  check(JSON.parse(text(await tool('cc_roles'))).reviewer?.model === 'opus', 'cc_roles lists the built-in roles')
  check(JSON.parse(text(await tool('cc_doctor'))).checks.length >= 8, 'cc_doctor runs its checks')
  check(Array.isArray(JSON.parse(text(await tool('cc_cleanup', { days: 30 }))).removed), 'cc_cleanup runs')

  const ver = await tool('cc_cli', { args: ['--version'] })
  check(!ver.isError && /Claude Code/.test(text(ver)), `cc_cli --version: ${text(ver).split('\n')[1]}`)
  const mcpList = await tool('cc_cli', { args: ['mcp', 'list'], timeout: 120 })
  check(/exit 0/.test(text(mcpList)), 'cc_cli mcp list')
  check((await tool('cc_cli', { args: ['-p', 'hi'] })).isError, 'cc_cli refuses non-allowlisted commands')

  await tool('cc_settings_set', { scope: 'local', cwd: tmp, key: 'env.FOO', value: 'bar' })
  const got = JSON.parse(text(await tool('cc_settings_get', { scope: 'local', cwd: tmp, key: 'env.FOO' })))
  check(got.value === 'bar', 'cc_settings_set/get round trip')
  await tool('cc_permission', { scope: 'local', cwd: tmp, action: 'add', list: 'allow', rule: 'Bash(npm test:*)' })
  const perm = JSON.parse(fs.readFileSync(path.join(tmp, '.claude', 'settings.local.json'), 'utf8'))
  check(perm.permissions.allow.includes('Bash(npm test:*)') && perm.env.FOO === 'bar', 'cc_permission add writes the file')
  await tool('cc_settings_set', { scope: 'local', cwd: tmp, key: 'env.FOO' })
  check(JSON.parse(text(await tool('cc_settings_get', { scope: 'local', cwd: tmp, key: 'env.FOO' }))).value === null, 'cc_settings_set without value deletes')
  console.log('PASS')
} catch (e) {
  console.error(e.message)
  process.exitCode = 1
  await tool('cc_stop', { name }).catch(() => {})
} finally {
  await client.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}
