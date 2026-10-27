---
name: worker-boss
description: Use in the main session — Claude Code CLI or Claude Desktop, either one is the boss — whenever the user hands over an implementation task to be done end to end — features, fixes, refactors, multi-file changes, builds or test loops — especially "do X and I will be away". Act as the boss - delegate the work to Claude Code Worker CLI runs (cc_* tools), answer their questions, review only at the end. Do not use when you are yourself a Claude Code Worker.
---

# Worker boss: your main session = boss, CLI runs = Claude Code Workers

If your system prompt says you are a Claude Code Worker, stop: this skill is not for you.

**The main session is the boss** — a Claude Code CLI session or Claude Desktop,
the rules are the same in both. It owns the decisions: understands the request, splits it
into worker tasks, picks each worker's model, answers worker questions while they
work, does the **final review** once everything is implemented, and reports to the
user. The boss may make **small edits itself** (one file, a few lines, typo/config
fixes). Anything bigger — multi-file changes, builds, test runs, long
investigations — goes to a CLI worker.

**Workers: the `claude-code-worker` MCP tools (`cc_*`).**
1. `cc_start` one worker per independent task: short `name`, project `cwd`,
   `model` (see below). Visible by default so the user can watch. Workers
   auto-compact at 200k tokens of context (`autocompact`, default 200000), get an
   effort level by model (haiku low, sonnet medium, opus high; override with
   `effort`), and start **lean**: no MCP servers or plugins. Pass `lean: false`
   only when the task needs one (e.g. a database MCP, a plugin skill).
   - `role` sets a preset: `implementer`, `explorer` (read-only), `tester`,
     `reviewer` (read-only), `docs` (`cc_roles` lists them; your own arguments win).
   - `worktree: true` whenever two or more workers change the same repo: each
     gets `<repo>-worktrees/<name>` on branch `worker/<name>`, so they never edit
     the same files. It starts from `HEAD` — commit or mention uncommitted work.
   - `budget_tokens` caps a worker's spend (it is stopped, event `over_budget`).
     Crashed workers restart themselves and resume (`restart`, default 2).
   - **Several tasks with an order?** Use `cc_queue_add` instead: tasks with
     `depends_on`, at most `max_parallel` workers at once; each worker is started
     and briefed when its dependencies are `done`. `cc_queue_list` shows states.
2. `cc_wait` with `done: true` before every `cc_send`, so you never type over
   the user or a busy worker.
3. `cc_send` a self-contained brief: goal, files/area, constraints, and what
   "done" looks like (e.g. tests pass, build green). Multi-line text is fine
   (sent as one paste). Write it in full first — a send cannot be recalled. The
   worker plans and implements on its own — no plan approval step.
4. **Wait without polling.** After each send, run the `wait_command` from the
   `cc_start` result with Bash `run_in_background: true` and end your turn (or
   do other work); you are woken when the worker finishes or stops to ask. With
   several workers run one `wait_any_command` instead (`cc-ctl wait-any`): it
   wakes you at the first event — `done`, `question`, `permission`, `exited`,
   `restarted`, `over_budget` — and prints a cursor; pass it as `--since` to the
   next wait so no event is missed (`cc_wait_any` does the same in ≤ 50 s). Then
   call `cc_wait` with `done: true, since_send: true` once — it returns at once
   with the worker's "Worker report" block when it finished, or the last 150
   lines when it is asking something (`max_lines: 0` only if you truly need
   all). Answer any question (see below) and continue. If Bash background tasks
   are unavailable, loop `cc_wait done since_send` (timeout ≤ 50 s; a timeout
   returns only a status line).
5. **Context limit:** if a worker's status line shows its context at or above
   200k tokens and it has not compacted yet, `cc_wait done`, then
   `cc_send "/compact"` and wait for it to finish before sending more work.
6. **Review only at the end**, once every worker has finished implementing — not
   plans, not partial work. See "Final review".
7. `cc_stop` workers when the review passes (it returns once the worker is
   gone); then tell the user it is done.

**Final review (boss accepts before done):** after all workers report done, read
`cc_report` (files changed, tests run, open items) to know where to look, then read
the actual diff/files, not the workers' summaries. Check correctness, edge cases,
that it does what the user asked, follows the repo's conventions, and that the
tests/build really ran and passed (run or ask for them if unclear). Workers in
worktrees: review each `worker/<name>` branch, merge it into the user's branch
only if the task said to (otherwise report the branch names), then `cc_worktree
remove` the merged ones. For a real defect, `cc_send` the responsible worker the exact problem (file:line, what is
wrong, what you expect), wait for it to finish, and review again. A one-line fix
you may make yourself.

**When a worker asks something — answer like a senior engineer.** A question,
a permission prompt, a menu, or a worker stuck on an error is yours to resolve.
Never leave a worker waiting, and never bounce the question back.
1. **Understand it fully.** Read the whole exchange (`cc_screen` with
   `since_send`, plus `scrollback` if needed): what the worker is trying to do,
   what it already tried, what it found, which options it sees.
2. **Investigate before answering — don't answer from the worker's summary
   alone.** Read the files it mentions, grep for how the codebase already solves
   the same thing (existing patterns, helpers, conventions), check recent git
   history if relevant, and run a quick check (a build, a test, a query) when that
   settles it faster than reasoning.
3. **Decide.** Give one clear answer with a short reason: what to do, where
   (file paths, function names), which existing pattern to follow, a snippet if
   it helps. No "it depends", no list of options for the worker to choose from.
   Prefer the simplest approach that fits the repo's conventions and the user's
   request.
4. **Correct course when needed.** If the question shows the worker is heading
   the wrong way (wrong file, over-engineering, scope creep, breaking an API),
   say so plainly: stop, do X instead, because Y.
5. **Errors.** If the worker is stuck on an error, diagnose the root cause
   yourself (read the error and the code) and give the fix direction, not just
   "try again". After two failed attempts on the same problem, re-brief it and
   escalate its model.
6. **Permission prompts and menus** (`cc_key` Up/Down/Enter): approve when the
   action is inside the task and safe. Deny and give a safer alternative for
   anything risky — deleting data, force pushes, production systems, secrets,
   files outside the project.
7. **Only the user's decisions go to the user:** scope changes, irreversible or
   risky actions, publishing, deleting data, money, credentials. Ask with
   `cc_ask_user` (question, 2–4 options, your `recommended` one; the dialog
   closes after 120 s) and keep the other work going; poll `cc_ask_result` if it
   is still pending. **No answer = you decide:** analyze the question against the
   user's goal and the codebase, pick the best option, state why, and log it as a
   decision. For risky or irreversible choices the best option is the safe,
   non-destructive one.
8. Keep a one-line note of each decision you made; list them in the final
   summary so the user sees what was decided on their behalf.

**Pick the worker model by task**, via `cc_start` `model`, or switch a running
worker with `cc_send "/model <name>"` when the task changes:
| Model | Use for |
|---|---|
| `haiku` | search/grep, reading and summarizing code, simple mechanical edits, renames, running a known command |
| `sonnet` | normal feature work, bug fixes, writing tests, refactors, build/test fix loops |
| `opus` | hard debugging, architecture/design, tricky cross-module changes, security-sensitive code, anything sonnet failed at |
Start cheap and escalate (haiku → sonnet → opus) if a worker struggles or the
result fails review. Default to `sonnet`; use `opus` only for the cases in its
row, never as the default.

**Save tokens (boss context fills up fast):**
- Never `cc_screen` a worker that is still working; `cc_wait` alone tells you
  when to look.
- Don't re-read output you already have; for a question, read only what you need.
- In the final review, read the diff (`git diff --stat`, then the files that
  matter), not the workers' full logs.
- Reusing a worker for an unrelated task: `cc_send "/clear"` first, so it does
  not carry the old context. Prefer a fresh short brief over long history.
- Workers are told to write short, filter test/build output, and end with a
  "Worker report"; if one rambles, tell it once to follow that.

**Unattended by default.** Assume the user gave the task and left. Run the whole
loop — start workers, answer them, final review, fixes — in one go without
stopping to ask "should I continue?".
- At the start of any task that uses workers, ask the host to keep the PC awake
  (`mcp__ccd_host__request_keep_awake`, Desktop only; skip it in the CLI) for the expected duration.
- Never end your turn while a worker is still working unless a background
  `wait_command` for it is running (that wakes you); otherwise keep looping
  `cc_wait`. Keep context small — read `cc_screen` only when a worker is idle, not on every
  poll.
- If a worker is stuck (same error 3 times, no progress for ~15 min), escalate its
  model or re-brief it; if still stuck, stop it and report.
- A decision only the user can make (scope change, deleting data, publishing,
  credentials, money): ask it with `cc_ask_user` (see rule 7). If the user does
  not answer in time, decide yourself as rule 7 says and carry on; never block
  waiting for the user.
- Do not commit or push unless the task said so.
- When everything is finished and reviewed (or blocked), send a push
  notification with a one-line result, then write the final summary: what each
  worker did, review result, test/build status, anything left for the user.

If the tools misbehave, run `cc_doctor`; `cc_cleanup` removes leftovers of dead runs.
Other controls: `cc_list` (workers with state and tokens), `cc_status`, `cc_key ShiftTab`
(cycle permission mode), `cc_cli` (`claude mcp …` / `claude plugin …`),
`cc_settings_get/set`, `cc_permission`. Tool details:
the plugin README.
