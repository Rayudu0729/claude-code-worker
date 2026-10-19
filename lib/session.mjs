import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const sessionDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'state'), 'cc-bridge')

export function validName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/i.test(name)
}

export function sessionPath(name) {
  if (!validName(name)) throw new Error(`invalid session name: ${name}`)
  return path.join(sessionDir, `${name.toLowerCase()}.json`)
}

export function readSession(name) {
  try { return JSON.parse(fs.readFileSync(sessionPath(name), 'utf8')) } catch { return null }
}

export function writeSession(name, data) {
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(sessionPath(name), JSON.stringify(data, null, 2), { mode: 0o600 })
}

export function removeSession(name) {
  try { fs.unlinkSync(sessionPath(name)) } catch {}
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}
