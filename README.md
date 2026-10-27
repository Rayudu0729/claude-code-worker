# Claude Code Worker (cc-bridge)

Run the interactive `claude` CLI so that both you and a boss Claude session can drive the same run.
With the MCP server, one boss session — Claude Code CLI or Claude Desktop, the same rules in both — can start
and drive CLI "worker" runs: hand out tasks, answer the workers' questions, and review their work at the end.
Design: `DESIGN.md`. Plan: `PLAN.md`.

## Install as a Claude Code plugin (`cli-workers`)

Windows (ConPTY), Node 24+, and the `claude` CLI on `PATH`; `git` for worktrees. macOS and Linux should work
(prebuilt `node-pty` binaries, hidden runs only, ask dialog via `osascript` / `zenity`) but are untested.
Check a setup with `node cc-ctl.mjs doctor` or the `cc_doctor` tool.

```powershell
claude plugin marketplace add Rayudu0729/claude-code-worker
claude plugin install cli-workers@cli-workers
```

Or inside a session: `/plugin marketplace add Rayudu0729/claude-code-worker`, then
`/plugin install cli-workers@cli-workers`. Start a new session afterwards.

The plugin brings:

| Part | What |
|---|---|
| MCP server `claude-code-worker` | the `cc_*` tools below (`mcp__plugin_cli-workers_claude-code-worker__cc_*`) |
| Skill `worker-boss` | the boss rules: delegate to workers, pick models, answer questions, review only at the end, run unattended |
| `/worker-run <task>` | hand a task to workers and run it unattended |
| `/workers [stop <name>\|stop all]` | list or stop workers |
| SessionStart hook | runs `npm ci` in the plugin folder on first use and after updates (the MCP launcher does the same if it starts first) |
| UserPromptSubmit hook | boss mode: on every message in a main session, tells Claude to use `worker-boss` and delegate implementation work to workers (silent inside workers and for `/worker-run`, `/workers`) |

To use the tools without permission prompts, add
`"permissions": { "allow": ["mcp__plugin_cli-workers_claude-code-worker"] }` to `~/.claude/settings.json`.

### Manual install (without the plugin system)

```powershell
git clone https://github.com/Rayudu0729/claude-code-worker $HOME\.claude\tools\cc-bridge
cd $HOME\.claude\tools\cc-bridge
npm ci
node smoke.mjs
claude mcp add -s user claude-code-worker -- node $HOME\.claude\tools\cc-bridge\cc-mcp.mjs
```

The boss rules are then in `skills/worker-boss/SKILL.md`; copy them into `~/.claude/CLAUDE.md`.

## Start a run (in your terminal; uses your CLI account)

```powershell
node $HOME\.claude\tools\cc-bridge\cc-bridge.mjs start <name>
node $HOME\.claude\tools\cc-bridge\cc-bridge.mjs start <name> -- claude "/review"
```

Type in it as usual. It ends when `claude` exits.

## Control it (from the boss session)

```powershell
node $HOME\.claude\tools\cc-bridge\cc-ctl.mjs <command> <name> ...
```

| Command | Does |
|---|---|
| `screen <name> [--scrollback N]` | print the visible screen |
| `send <name> "<text>" [--enter]` | type text, optionally submit |
| `key <name> <Enter\|Esc\|Tab\|ShiftTab\|Up\|Down\|Left\|Right\|Backspace\|CtrlC> [--repeat N]` | press a key |
| `wait <name> --done \| --idle <sec> \| --match <regex> [--timeout <sec>] [--quiet]` | block until the claude turn is over, quiet, or matched, then print the screen (`--quiet`: one line; exit 2 on timeout) |
| `status <name>` / `stop <name>` | status JSON (state, tokens, restarts) / Ctrl-C, then kill after 3 s |
| `list` | live runs |
| `wait-any [names...] [--since <ms>] [--timeout <sec>] [--quiet]` | block until any worker (or one of `names`) changes state; prints `<name>: <kind>` per event and `cursor <ms>` for the next `--since` |
| `ask "<question>" [--option <text>]... [--recommended <text>] [--timeout <sec>]` | timed dialog to the user; prints the result JSON (exit 0 answered, 5 no answer) |
| `doctor` / `cleanup [--days N]` | check the setup / remove leftovers of dead runs |

Exit 3 = not running. Control is on 127.0.0.1 only, with a per-run token in
`%LOCALAPPDATA%\cc-bridge\<name>.json` (removed on exit).

## MCP server (native tools for the boss: Claude Code CLI or Desktop)

`cc-mcp.mjs` exposes the same controls as MCP tools, as the MCP server **claude-code-worker**. Through the plugin the tools appear as `mcp__plugin_cli-workers_claude-code-worker__cc_*`; with a manual install as `mcp__claude-code-worker__cc_*`, registered with:

```powershell
claude mcp add -s user claude-code-worker -- node $HOME\.claude\tools\cc-bridge\cc-mcp.mjs
```

| Tool | Does |
|---|---|
| `cc_start` | start a worker run: `name`, `cwd`, `role` (preset, see below), `model` (haiku/sonnet/opus), `permission_mode`, `autocompact` (default 200000 tokens), `effort` (default by model: haiku low, sonnet medium, opus high), `lean` (default true: no MCP servers or plugins), `worktree` (own git worktree and branch), `restart` (crash restarts, default 2), `budget_tokens` (stop when passed), `args` (claude flags / first prompt), `visible` (new terminal window, default) or hidden. Workers always use the inline TUI (`--settings {"tui":"default"}`) so output has scrollback, and get a system-prompt note plus `CC_BRIDGE_WORKER` env so they don't follow the orchestrator rules in the global CLAUDE.md or start workers. The result shows the effective permission mode and a `wait_command` (`cc-ctl wait <name> --done --quiet`) to run in the background instead of polling; `command` shows `<worker prompt>` instead of the prompt text |
| `cc_list` | live runs with state (working, done, question, permission, idle), tokens, role, model, branch |
| `cc_wait_any` | block until any worker (or `names`) changes state; returns events (`done`, `question`, `permission`, `exited`, `restarted`, `over_budget`) and a `cursor` for the next call, plus a `wait_any_command` for background waits |
| `cc_report` | the worker's JSON report: `status`, `summary`, `files_changed`, `tests`, `open`; `fresh` = written after the last send |
| `cc_queue_add` / `cc_queue_list` / `cc_queue_cancel` | task queue: tasks with `depends_on`, started as workers when their dependencies are done, at most `max_parallel` (default 3) at once |
| `cc_worktree` | list / remove worker worktrees (`delete_branch`, `force`) |
| `cc_roles` | worker presets |
| `cc_ask_user` / `cc_ask_result` | timed question dialog to the user (default 120 s); on no answer the boss decides itself and logs it |
| `cc_doctor` / `cc_cleanup` | setup checks / remove leftovers of dead runs (also run when the server starts) |
| `cc_screen` / `cc_status` | read screen (`since_send` = whole output since the last send, or `scrollback` lines) with a working/idle state / status |
| `cc_send` | type text, Enter by default — prompts and slash commands (`/model opus`, `/mcp`, `/compact`). Multi-line text goes as one bracketed paste and is submitted once |
| `cc_key` | press a key (ShiftTab cycles permission mode) |
| `cc_wait` | block until `done` (claude turn over: no "esc to interrupt", screen steady 2 s), `idle` seconds, or regex `match`; `since_send` returns the worker's "Worker report" block when it finished, else the reply (last `max_lines`, default 150); a timeout returns only a status line. Keep `timeout` ≤ 50 s |
| `cc_stop` | stop a run; returns once it is gone |
| `cc_cli` | `claude mcp …`, `claude plugin …`, `claude --version` (other subcommands refused) |
| `cc_settings_get` / `cc_settings_set` | read / set / delete a dotted key in user, project or local `settings.json` |
| `cc_permission` | add / remove an allow, deny or ask rule |

Runs started by the MCP server drop the host session's `CLAUDECODE`, `CLAUDE_CODE_*`,
`CLAUDE_AGENT_SDK_*`, `ANTHROPIC_BASE_URL` etc. so they behave like a run from your own shell; any of
those you set in your Windows user or system environment are kept. Hidden runs log the terminal
stream to `%LOCALAPPDATA%\cc-bridge\<name>.log`.

## Parallel work, queue and events

- **Worktrees.** `cc_start` with `worktree: true` creates `<repo>-worktrees/<name>` on branch `worker/<name>` (or the
  branch you name) from `HEAD`, so parallel workers never edit the same files. Uncommitted changes in the main
  checkout are not carried over. A new worktree's folder-trust prompt is accepted automatically. Merge the branch
  yourself, then `cc_worktree remove` (with `delete_branch`).
- **Queue.** `cc_queue_add` takes tasks `{ id, prompt, depends_on, ...cc_start options }`. The MCP server checks the
  queue every 3 s, starts a task's worker once its dependencies are `done`, waits for the prompt, and sends the brief.
  States: `pending → starting → running ⇄ needs_input → done | failed | blocked | cancelled`. A task whose dependency
  fails is `blocked`. Finished workers stay up for review. The scheduler only runs while the boss session is open.
- **Events.** Each bridge watches its screen; when a claude turn ends it appends to `%LOCALAPPDATA%\cc-bridge\events.jsonl`:
  `done` (ended with a Worker report or a fresh JSON report), `permission` (a menu waits), `question` (anything
  else), plus `exited`, `restarted`, `over_budget`. Run the `wait_any_command` in the background and you are woken by
  the first worker that needs you.
- **Reports.** Workers also write their report as JSON to `%LOCALAPPDATA%\cc-bridge\reports\<name>.json` (the folder
  is passed with `--add-dir`). `cc_wait since_send` shows it first; `cc_report` returns it.
- **Restarts.** Each claude worker gets a `--session-id`. If it exits non-zero without `cc_stop`, the bridge
  restarts it with `--resume <id>` (or the original command when there was no conversation yet), up to `restart`
  times.
- **Budgets.** Token use is read from the worker's transcript (`~/.claude/projects/*/<session id>.jsonl`): `tokens`
  = input + cache writes + output, `cache_read` and the current `context` apart. It updates as claude writes
  messages (after a turn or tool approval). With `budget_tokens` the bridge stops the worker once `tokens` passes it.
- **Roles.** `role`: `implementer` (sonnet), `explorer` (haiku, plan mode, read-only), `tester` (sonnet), `reviewer`
  (opus, plan mode), `docs` (sonnet, low effort). Add or override in `~/.claude/cc-workers/roles.json`:
  `{ "<role>": { "model", "effort", "permission_mode", "prompt" } }`. Explicit `cc_start` arguments win.

## Asking the user with a timeout

`cc_ask_user` shows a topmost dialog (Windows: one button per option, a free-text box, a countdown) that closes
after `timeout_sec` (default 120). The call waits up to 50 s and returns `pending` with an `id` for `cc_ask_result`
if the dialog is still open. If the user does not answer, the boss analyzes the question, picks the best option
itself, says why, and lists it as a decision in its final summary; for risky or irreversible choices it picks the
safe option.

## Test

```powershell
node $HOME\.claude\tools\cc-bridge\smoke.mjs
node $HOME\.claude\tools\cc-bridge\mcp-smoke.mjs [--visible]
```
