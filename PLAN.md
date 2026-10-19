# cc-bridge Implementation Plan

**Goal:** Build the tool in `DESIGN.md`: a PTY bridge around interactive `claude` plus a control client.

**Architecture:** `cc-bridge.mjs` owns the PTY (`@lydell/node-pty`, prebuilt ConPTY binaries), mirrors
output to the real terminal and to an `@xterm/headless` screen, and serves a token-guarded HTTP API on
127.0.0.1. `cc-ctl.mjs` reads the session file and calls that API. No other state.

**Tech stack:** Node 24 ESM, `@lydell/node-pty@1.1.0`, `@xterm/headless@5.5.0`. No build step.

Location: any folder, e.g. `~/.claude/tools/cc-bridge/`.

## Files

| File | Responsibility |
|---|---|
| `package.json` | pinned deps, `"type": "module"` |
| `lib/session.mjs` | session-file path, name validation, read/write/remove |
| `lib/keys.mjs` | key name → byte sequence |
| `cc-bridge.mjs` | spawn, passthrough, headless screen, HTTP API, cleanup |
| `cc-ctl.mjs` | `screen send key wait status stop` |
| `cc-bridge.cmd`, `cc-ctl.cmd` | launchers |
| `smoke.mjs` | automated smoke + auth test (DESIGN §Testing 1–2) |

## Tasks

1. **Deps** — `npm install` with exact versions. Check: `node -e "import('@lydell/node-pty')"` loads.
2. **lib/** — `validName` (`/^[a-z0-9][a-z0-9-]{0,31}$/i`), `sessionPath(name)` under
   `%LOCALAPPDATA%\cc-bridge`, `readSession`, `writeSession`, `removeSession`; `KEYS` map
   (Enter `\r`, Esc `\x1b`, Tab `\t`, ShiftTab `\x1b[Z`, Up/Down/Right/Left `\x1b[A/B/C/D`,
   Backspace `\x7f`, CtrlC `\x03`).
3. **cc-bridge.mjs** — parse `start <name> [-- cmd args]`; refuse a live duplicate; resolve `claude`
   via `where.exe` (`.cmd` → `cmd.exe /d /c`); spawn at terminal size; raw stdin → PTY; PTY →
   stdout + headless term; follow resize; HTTP routes `/screen /send /key /status /stop` with bearer
   token (timing-safe compare), 64 kB body cap; `send` writes text then `\r` after 150 ms so the TUI
   does not treat it as a pasted newline; exit → remove file, close server, exit with child code.
4. **cc-ctl.mjs** — subcommands per DESIGN; exit 3 when not running (removing a stale file on
   ECONNREFUSED), 2 on wait timeout; `wait` prints the final screen.
5. **smoke.mjs** — start bridge on `powershell -NoLogo -NoProfile`, `send "echo hi-$((2+3))"` with
   enter, `wait --match "^hi-5$"`, bad token → 401, `stop` → session file gone. Run:
   `node smoke.mjs` → `PASS`.
6. **Real run** — `cc-bridge start demo` in a terminal tab; from the desktop session `cc-ctl wait demo
   --idle 3`, `send` a prompt, read `screen`; user types in the same run.
