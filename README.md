# Claude Code Worker (cc-bridge)

Run the interactive `claude` CLI so that both you and a Claude desktop session can drive the same run.
With the MCP server, a Claude Desktop (or Claude Code) session can start and drive CLI "worker" runs
as a boss: hand out tasks, answer the workers' questions, and review their work at the end.
Design: `DESIGN.md`. Plan: `PLAN.md`. Boss/worker instructions for `CLAUDE.md`:
`docs/orchestrator-CLAUDE.md`.

## Install

Windows (ConPTY), Node 24+, and the `claude` CLI on `PATH`.

```powershell
git clone https://github.com/Rayudu0729/claude-code-worker $HOME\.claude\tools\cc-bridge
cd $HOME\.claude\tools\cc-bridge
npm ci
node smoke.mjs
claude mcp add -s user claude-code-worker -- node $HOME\.claude\tools\cc-bridge\cc-mcp.mjs
```

Optionally allow the tools without prompts (`"permissions": { "allow": ["mcp__claude-code-worker"] }`
in `~/.claude/settings.json`) and append `docs/orchestrator-CLAUDE.md` to `~/.claude/CLAUDE.md`.

## Start a run (in your terminal; uses your CLI account)

```powershell
node $HOME\.claude\tools\cc-bridge\cc-bridge.mjs start <name>
node $HOME\.claude\tools\cc-bridge\cc-bridge.mjs start <name> -- claude "/review"
```

Type in it as usual. It ends when `claude` exits.

## Control it (from the desktop session)

```powershell
node $HOME\.claude\tools\cc-bridge\cc-ctl.mjs <command> <name> ...
```

| Command | Does |
|---|---|
| `screen <name> [--scrollback N]` | print the visible screen |
| `send <name> "<text>" [--enter]` | type text, optionally submit |
| `key <name> <Enter\|Esc\|Tab\|ShiftTab\|Up\|Down\|Left\|Right\|Backspace\|CtrlC> [--repeat N]` | press a key |
| `wait <name> --idle <sec> \| --match <regex> [--timeout <sec>]` | block until quiet or matched, then print the screen (exit 2 on timeout) |
| `status <name>` / `stop <name>` | status JSON / Ctrl-C, then kill after 3 s |

Exit 3 = not running. Control is on 127.0.0.1 only, with a per-run token in
`%LOCALAPPDATA%\cc-bridge\<name>.json` (removed on exit).

## MCP server (native tools for Claude Code / Desktop)

`cc-mcp.mjs` exposes the same controls as MCP tools, as the MCP server **claude-code-worker** (tools appear as `mcp__claude-code-worker__cc_*`). Registered at user scope:

```powershell
claude mcp add -s user claude-code-worker -- node $HOME\.claude\tools\cc-bridge\cc-mcp.mjs
```

| Tool | Does |
|---|---|
| `cc_start` | start a worker run: `name`, `cwd`, `model` (haiku/sonnet/opus), `permission_mode`, `autocompact` (default 400000 tokens), `args` (claude flags / first prompt), `visible` (new terminal window, default) or hidden. Workers always use the inline TUI (`--settings {"tui":"default"}`) so output has scrollback, and get a system-prompt note plus `CC_BRIDGE_WORKER` env so they don't follow the orchestrator rules in the global CLAUDE.md or start workers. The result shows the effective permission mode; `command` shows `<worker prompt>` instead of the prompt text |
| `cc_list` | live runs |
| `cc_screen` / `cc_status` | read screen (`since_send` = whole output since the last send, or `scrollback` lines) with a working/idle state / status |
| `cc_send` | type text, Enter by default — prompts and slash commands (`/model opus`, `/mcp`, `/compact`). Multi-line text goes as one bracketed paste and is submitted once |
| `cc_key` | press a key (ShiftTab cycles permission mode) |
| `cc_wait` | block until `done` (claude turn over: no "esc to interrupt", screen steady 2 s), `idle` seconds, or regex `match`; `since_send` returns the whole reply. Keep `timeout` ≤ 50 s |
| `cc_stop` | stop a run; returns once it is gone |
| `cc_cli` | `claude mcp …`, `claude plugin …`, `claude --version` (other subcommands refused) |
| `cc_settings_get` / `cc_settings_set` | read / set / delete a dotted key in user, project or local `settings.json` |
| `cc_permission` | add / remove an allow, deny or ask rule |

Runs started by the MCP server drop the host session's `CLAUDECODE`, `CLAUDE_CODE_*`,
`CLAUDE_AGENT_SDK_*`, `ANTHROPIC_BASE_URL` etc. so they behave like a run from your own shell; any of
those you set in your Windows user or system environment are kept. Hidden runs log the terminal
stream to `%LOCALAPPDATA%\cc-bridge\<name>.log`.

## Test

```powershell
node $HOME\.claude\tools\cc-bridge\smoke.mjs
node $HOME\.claude\tools\cc-bridge\mcp-smoke.mjs [--visible]
```
