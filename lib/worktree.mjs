import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export function repoRoot(cwd) {
  try { return path.resolve(git(cwd, ['rev-parse', '--show-toplevel'])) } catch { throw new Error(`not a git repository: ${cwd}`) }
}

// Worker worktrees live next to the repo, in <repo>-worktrees/<name>, so they never show up as
// untracked files inside it.
export function worktreeBase(root) {
  return path.join(path.dirname(root), `${path.basename(root)}-worktrees`)
}

// Create (or reuse) the worktree for worker `name` on branch `branch` (default worker/<name>), from the
// repo's current HEAD. Returns { path, cwd, branch, root, created }: cwd is the same subfolder of the
// worktree as `cwd` was of the repo. Uncommitted changes in the main checkout are not carried over.
export function createWorktree(cwd, name, branch = `worker/${name.toLowerCase()}`) {
  const root = repoRoot(cwd)
  const wt = path.join(worktreeBase(root), name.toLowerCase())
  // Long real paths on both sides: a Windows 8.3 short path (RAYUDU~1) would not be relative to git's root.
  const real = (p) => { try { return fs.realpathSync.native(p) } catch { return path.resolve(p) } }
  const rel = path.relative(real(root), real(cwd))
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${cwd} is not inside ${root}`)
  if (fs.existsSync(wt)) {
    if (!listWorktrees(root).some((w) => samePath(w.path, wt))) throw new Error(`${wt} exists but is not a worktree of ${root}`)
    return { path: wt, cwd: path.join(wt, rel), branch: git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']), root, created: false }
  }
  let exists = true
  try { git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) } catch { exists = false }
  git(root, ['worktree', 'add', ...(exists ? [wt, branch] : ['-b', branch, wt, 'HEAD'])])
  return { path: wt, cwd: path.join(wt, rel), branch, root, created: true }
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

// Worker worktrees of the repo at `cwd`: [{ name, path, branch, head, dirty }].
export function listWorktrees(cwd) {
  const root = repoRoot(cwd)
  const base = worktreeBase(root)
  const out = []
  let cur = null
  for (const line of git(root, ['worktree', 'list', '--porcelain']).split(/\r?\n/)) {
    if (line.startsWith('worktree ')) { cur = { path: path.resolve(line.slice(9)) }; out.push(cur) }
    else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5, 12)
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '')
  }
  return out.filter((w) => samePath(path.dirname(w.path), base)).map((w) => {
    let dirty = null
    try { dirty = git(w.path, ['status', '--porcelain']).length > 0 } catch {}
    return { name: path.basename(w.path), ...w, dirty }
  })
}

// Remove worker `name`'s worktree; deleteBranch also deletes its branch (git branch -d, or -D with force).
export function removeWorktree(cwd, name, { deleteBranch = false, force = false } = {}) {
  const root = repoRoot(cwd)
  const w = listWorktrees(root).find((x) => x.name.toLowerCase() === name.toLowerCase())
  if (!w) throw new Error(`no worker worktree "${name}" in ${worktreeBase(root)}`)
  git(root, ['worktree', 'remove', ...(force ? ['--force'] : []), w.path])
  if (deleteBranch && w.branch) git(root, ['branch', force ? '-D' : '-d', w.branch])
  return { removed: w.path, branch: w.branch, branch_deleted: Boolean(deleteBranch && w.branch) }
}
