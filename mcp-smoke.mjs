// End-to-end test of cc-mcp.mjs over stdio. Run: node mcp-smoke.mjs [--visible]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mcp-'))

try {
  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name)
  check(['cc_start', 'cc_list', 'cc_screen', 'cc_send', 'cc_key', 'cc_wait', 'cc_status', 'cc_stop', 'cc_cli', 'cc_settings_get', 'cc_settings_set', 'cc_permission'].every((n) => names.includes(n)), `all tools listed (${names.length})`)

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
  const { execSync } = await import('node:child_process')
  check(/: done$/.test(execSync(waitCmd, { encoding: 'utf8' }).trim()), 'wait_command (cc-ctl wait --done --quiet) prints one line')
  const rep = text(await tool('cc_screen', { name, since_send: true }))
  check(/report only/.test(rep) && !/^noise\s*$/m.test(rep) && /^- files: a.txt\s*$/m.test(rep), 'since_send returns only the Worker report block')
  const to = await tool('cc_wait', { name, match: 'never-appears-xyz', timeout: 2 })
  check(to.isError && text(to).split('\n').filter(Boolean).length <= 2, 'cc_wait timeout returns only a status line')

  await tool('cc_send', { name, text: 'echo "ml-a"\necho "ml-b"' })
  const ml = text(await tool('cc_wait', { name, match: '^ml-b\\s*$', timeout: 20 }))
  check(/^ml-a\s*$/m.test(ml) && /^ml-b\s*$/m.test(ml), 'multi-line cc_send runs both lines')

  check(JSON.parse(text(await tool('cc_status', { name }))).running === true, 'cc_status running')
  check(!(await tool('cc_key', { name, key: 'Enter' })).isError, 'cc_key Enter')

  const dup = await tool('cc_start', { name, command: ['powershell'] })
  check(dup.isError, 'duplicate start refused')

  check(/^stopped /.test(text(await tool('cc_stop', { name }))), 'cc_stop waits until the run is gone')
  check(!text(await tool('cc_list')).includes(name), 'cc_list no longer shows the run')
  check((await tool('cc_screen', { name })).isError, 'cc_screen on a stopped run is an error')

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
