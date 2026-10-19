# Claude Code Worker (cc-bridge) — shared control of an interactive Claude Code CLI

User-level tool, installed per user (e.g. `~/.claude/tools/cc-bridge`).

## Purpose

Let the user and a Claude desktop session drive the **same** interactive `claude` CLI run. The user
watches and types in their terminal tab as usual; the desktop session reads the screen and sends text
or keys. The run uses the CLI's own account (`CLAUDE_CODE_OAUTH_TOKEN` from the user's shell), not the
desktop session's.

## Components

| Unit | Does | Depends on |
|---|---|---|
| `cc-bridge.mjs` | `start <name> [-- args]`: spawns `claude` (or another command for tests) in a pseudo-terminal, passes output to the real terminal and keystrokes to the PTY, mirrors output into a headless terminal, serves the control channel | `node-pty`, `@xterm/headless` |
| `cc-ctl.mjs` | Client the desktop session runs: `screen`, `send`, `key`, `wait`, `status`, `stop` | Node built-ins only |
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
  met, 2 on timeout. This keeps waiting out of the desktop session's turn loop.

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
3. Real run: `cc-bridge start demo` in a terminal tab; the desktop session sends a prompt that makes
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

## Out of scope

Multiple viewers, remote access, recording or replay, and a web UI.
