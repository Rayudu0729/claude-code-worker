# Claude Code Worker (cc-bridge) — shared control of an interactive Claude Code CLI

User-level tool, installed per user (e.g. `~/.claude/tools/cc-bridge`).

## Purpose

Let the user and a boss Claude session (Claude Code CLI or Desktop) drive the **same** interactive `claude` CLI run. The user
watches and types in their terminal tab as usual; the boss session reads the screen and sends text
or keys. The run uses the CLI's own account (`CLAUDE_CODE_OAUTH_TOKEN` from the user's shell), not the
boss session's.

## Components

| Unit | Does | Depends on |
|---|---|---|
| `cc-bridge.mjs` | `start <name> [-- args]`: spawns `claude` (or another command for tests) in a pseudo-terminal, passes output to the real terminal and keystrokes to the PTY, mirrors output into a headless terminal, serves the control channel | `node-pty`, `@xterm/headless` |
| `cc-ctl.mjs` | Client the boss session runs: `screen`, `send`, `key`, `wait`, `status`, `stop` | Node built-ins only |
| `cc-bridge.cmd`, `cc-ctl.cmd` | Windows launchers | — |

## Control channel

- HTTP on `127.0.0.1`, random port, random 32-byte hex token in the `Authorization: Bearer` header.
  Never bound to another interface: anyone who can send keys can run commands in a CLI that may be in
  bypass-permissions mode.
- Session file `%LOCALAPPDATA%\cc-bridge\<name>.json` = `{ name, port, token, pid, command, started }`,
  readable only by the user; deleted on exit.
- Endpoints:
  - `GET /screen?scrollback=N` → `{ text, cursor: { x, y }, cols, rows, lastOutputAt, exited }`. Text is
    the rendered screen (rows trimmed on the right) plus up to N scrollback lines.
  - `POST /send { text, enter }` → writes the text, then `\r` if `enter`.
  - `POST /key { key, repeat }` → `Enter Esc Tab ShiftTab Up Down Left Right Backspace CtrlC`.
  - `GET /status` → `{ name, pid, running, exitCode, cols, rows, lastOutputAt }`.
  - `POST /stop` → sends Ctrl-C twice, then kills the PTY after 3 s if it is still running.
- `cc-ctl wait <name> --idle <sec> | --match <regex> [--timeout <sec>]` polls `/screen` every 500 ms
  client-side until the screen has not changed for `idle` seconds or the regex matches; exit 0 when
  met, 2 on timeout. This keeps waiting out of the boss session's turn loop.

## Behaviour

- The PTY starts at the real terminal's size and follows its resizes. The user's stdin is raw and
  forwarded byte for byte; Ctrl-C reaches `claude`, not the bridge.
- Both sides can type at any time. The session should `wait --idle` before sending so the two do not
  interleave keystrokes.
- On Windows `claude` is resolved through `where.exe claude` (the `.cmd`/`.exe` shim) and spawned
  with ConPTY.
- When the child exits the bridge prints the exit code, deletes the session file, closes the server
  and exits with the same code.

## Errors

- `cc-ctl` with no session file → `not running: <name>`, exit 3. Connection refused → stale file is
  removed, same message.
- Wrong or missing token → 401. Unknown key name → 400 listing the valid names.
- `start` with a name already running → refuses with exit 1.

## Testing

1. Smoke: `cc-bridge start t1 -- powershell -NoLogo`; `cc-ctl send t1 "echo hi" --enter`;
   `cc-ctl wait t1 --match "^hi$"`; `cc-ctl screen t1` shows `hi`; `cc-ctl stop t1` → file removed.
2. Auth: a request with a bad token gets 401; the port is not listening on the LAN address.
3. Real run: `cc-bridge start demo` in a terminal tab; the boss session sends a prompt that makes
   `claude` ask a question, waits for the menu, answers it with `key Down`/`key Enter`, and reads the
   result; the user types in the same run at the same time.

## MCP server (added 2026-10-19)

`cc-mcp.mjs` is a stdio MCP server, registered as `claude-code-worker` ("Claude Code Worker", renamed from `cc-bridge` 2026-10-19), over the same session files and HTTP API (`lib/client.mjs`), so a
Claude session gets native tools instead of shelling out to `cc-ctl`. `cc_start` writes the command
to `<name>.spec.json` (read and deleted by the bridge) so only fixed paths go through `cmd /c start`;
visible runs open a new console window, hidden runs are detached with output in `<name>.log`.
`cc_cli` runs `claude.exe` directly (resolved through the npm shim, never via cmd.exe) and only for
`mcp`, `plugin`, `plugins`, `--version`. Settings tools edit `settings.json` / `settings.local.json`
by dotted key. Child processes get `childEnv()`: host-session variables stripped unless the user set
them persistently, `PATHEXT` defaulted for trimmed MCP environments.

## Plugin (added 2026-10-19)

Packaged as the Claude Code plugin `cli-workers` (names starting with `claude-` are reserved), with
the repo root as a one-plugin marketplace. `.mcp.json` starts `scripts/mcp-launch.mjs`, which runs
`scripts/ensure-deps.mjs` (npm ci when `node_modules` is missing or the lock file changed, guarded by a
lock dir) before importing `cc-mcp.mjs`; a SessionStart hook runs the same check. The boss rules are
the `worker-boss` skill; `/worker-run` and `/workers` are commands.

## Workers v2 (added 2026-10-27)

One boss session, Claude Code CLI or Desktop, with the same rules in both.

| Piece | Where | How |
|---|---|---|
| Events | `cc-bridge.mjs` watcher, `lib/events.mjs` | Every second the bridge checks its screen. After "esc to interrupt" disappears and the screen holds for 2 s it appends `{t, name, kind}` to `events.jsonl`: `done` if a Worker report is in the output since the last send (or the JSON report is newer than that send), `permission` if a menu is up, else `question`. `exited`, `restarted` and `over_budget` come from the exit, restart and budget paths. `wait-any` / `cc_wait_any` poll the file from a cursor. |
| Since-send after a clear | `screen()` | A clear rewrites the viewport above the send marker; an empty since-send range falls back to the visible screen. |
| Structured reports | worker prompt, `--add-dir reports` | The worker writes `reports/<name>.json` before its text report; the file's mtime against `lastSendAt` says whether it is fresh. |
| Token use and budgets | `lib/usage.mjs` | Workers start with `--session-id <uuid>`. The bridge reads `~/.claude/projects/*/<uuid>.jsonl` incrementally, counting each message id once. With `budgetTokens` it stops the run (checked every 5 s). |
| Restarts | `onChildExit` | A non-zero exit without `/stop` respawns the PTY child after 2 s with `--resume <uuid>`, or the original command when no transcript exists yet, up to `restart.max`. |
| Worktrees | `lib/worktree.mjs` | `git worktree add -b worker/<name> <repo>-worktrees/<name> HEAD`, using real long paths so 8.3 names stay relative. The trust prompt in a new worktree is accepted with Enter. |
| Queue | `lib/queue.mjs`, MCP server | `queue.json` holds the tasks. A 3 s tick in the MCP server updates active tasks from `/status`, then starts pending ones whose dependencies are done, up to `max_parallel`. Starting means: start the worker, wait for done, pause 3 s (claude drops an Enter sent right after its first screen settles), then send the brief. |
| Roles | `lib/roles.mjs` | Built-in presets merged with `~/.claude/cc-workers/roles.json`. |
| Timed ask | `lib/ask.mjs`, `scripts/ask-dialog.*` | A detached node process shows the dialog (WinForms / osascript / zenity) and writes `asks/<id>.out.json`. Callers wait at most 50 s per call. On no answer the boss decides itself, as the skill says. |
| Maintenance | `lib/maint.mjs` | `doctor` checks node, deps, claude, git, the state folder, stale sessions and the dialog tool. `cleanup` (also run at MCP start) removes dead session files and old logs, reports and asks, and keeps the last 1000 events. |

`.mcp.json` uses `${CLAUDE_PLUGIN_ROOT:-.}`, so opening this repo as a project starts its own server instead
of failing on an unset variable.

## Out of scope

Multiple viewers, remote access, recording or replay, and a web UI. macOS and Linux are expected to work
but are untested.
