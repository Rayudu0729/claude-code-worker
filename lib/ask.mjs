import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { sessionDir } from './session.mjs'

// Timed questions to the user: a desktop dialog that closes by itself after timeoutSec. The dialog
// runs in a detached process and writes asks/<id>.out.json, so the asker can return and poll.
export const asksDir = path.join(sessionDir, 'asks')
const dialogScript = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ask-dialog.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function startAsk({ question, options = [], recommended, timeoutSec = 120 }) {
  fs.mkdirSync(asksDir, { recursive: true })
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`
  fs.writeFileSync(path.join(asksDir, `${id}.in.json`), JSON.stringify({ question, options, recommended, timeoutSec }), { mode: 0o600 })
  spawn(process.execPath, [dialogScript, id], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  return id
}

// { id, answered, choice?, text?, timed_out?, error? } once the dialog closed, else null.
export function readAsk(id) {
  if (!/^[a-z0-9]+-[0-9a-f]{6}$/.test(id ?? '')) throw new Error(`invalid ask id: ${id}`)
  try { return { id, ...JSON.parse(fs.readFileSync(path.join(asksDir, `${id}.out.json`), 'utf8').replace(/^﻿/, '')) } } catch { return null }
}

export async function waitAsk(id, waitSec) {
  const deadline = Date.now() + waitSec * 1000
  for (;;) {
    const r = readAsk(id)
    if (r || Date.now() > deadline) return r
    await sleep(500)
  }
}
