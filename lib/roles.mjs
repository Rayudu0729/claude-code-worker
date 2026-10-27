import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Worker presets for cc_start `role`. Explicit cc_start arguments win over the role's values.
// Users can add or override roles in ~/.claude/cc-workers/roles.json: { "<role>": { model, effort, permission_mode, prompt } }.
export const BUILTIN_ROLES = {
  implementer: { model: 'sonnet', effort: 'medium', prompt: 'Role: implementer. Build the requested change end to end, with tests where the repo has them.' },
  explorer: { model: 'haiku', effort: 'low', permission_mode: 'plan', prompt: 'Role: explorer. Read-only: search and read code and answer with file:line references. Do not edit files.' },
  tester: { model: 'sonnet', effort: 'medium', prompt: 'Role: tester. Write and run tests for the area you are given. Do not change product code; report bugs you find with file:line and a failing test.' },
  reviewer: { model: 'opus', effort: 'high', permission_mode: 'plan', prompt: 'Role: reviewer. Review the diff or files you are given for correctness bugs, edge cases and convention breaks. Do not edit files; list findings most severe first with file:line.' },
  docs: { model: 'sonnet', effort: 'low', prompt: 'Role: docs writer. Update README/docs/comments for the change you are given. Match the existing tone; do not change code.' },
}

export const rolesFile = path.join(os.homedir(), '.claude', 'cc-workers', 'roles.json')

export function loadRoles() {
  let user = {}
  try { user = JSON.parse(fs.readFileSync(rolesFile, 'utf8')) } catch {}
  const roles = { ...BUILTIN_ROLES }
  for (const [k, v] of Object.entries(user)) if (v && typeof v === 'object') roles[k] = { ...roles[k], ...v }
  return roles
}
