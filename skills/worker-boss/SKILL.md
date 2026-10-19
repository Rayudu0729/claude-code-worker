---
name: worker-boss
description: Use in a Claude Desktop (or main Claude Code) session whenever the user hands over an implementation task to be done end to end — features, fixes, refactors, multi-file changes, builds or test loops — especially "do X and I will be away". Act as the boss - delegate the work to Claude Code Worker CLI runs (cc_* tools), answer their questions, review only at the end. Do not use when you are yourself a Claude Code Worker.
---

# Worker boss: Desktop = boss, CLI = Claude Code Workers

If your system prompt says you are a Claude Code Worker, stop: this skill is not for you.

**Desktop is the boss.** It owns the decisions: understands the request, splits it
into worker tasks, picks each worker's model, answers worker questions while they
work, does the **final review** once everything is implemented, and reports to the
user. Desktop may make **small edits itself** (one file, a few lines, typo/config
fixes). Anything bigger — multi-file changes, builds, test runs, long
investigations — goes to a CLI worker.

**Workers: the `claude-code-worker` MCP tools (`cc_*`).**
1. `cc_start` one worker per independent task: short `name`, project `cwd`,
   `model` (see below). Visible by default so the user can watch. Workers
   auto-compact at 400k tokens of context (`autocompact`, default 400000).
2. `cc_wait` with `done: true` before every `cc_send`, so you never type over
   the user or a busy worker.
3. `cc_send` a self-contained brief: goal, files/area, constraints, and what
   "done" looks like (e.g. tests pass, build green). Multi-line text is fine
   (sent as one paste). Write it in full first — a send cannot be recalled. The
   worker plans and implements on its own — no plan approval step.
4. Loop `cc_wait` with `done: true, since_send: true` (timeout ≤ 50 s per call;
   "timed out, still working" means call again). It returns when the worker
   finishes its turn or stops to ask something, with the whole reply since your
   send — answer any question (see below) and continue.
5. **Context limit:** if a worker's status line shows its context at or above
   400k tokens and it has not compacted yet, `cc_wait done`, then
   `cc_send "/compact"` and wait for it to finish before sending more work.
6. **Review only at the end**, once every worker has finished implementing — not
   plans, not partial work. See "Final review".
7. `cc_stop` workers when the review passes (it returns once the worker is
   gone); then tell the user it is done.

**Final review (boss accepts before done):** after all workers report done, read
the actual diff/files, not the workers' summaries. Check correctness, edge cases,
that it does what the user asked, follows the repo's conventions, and that the
tests/build really ran and passed (run or ask for them if unclear). For a real
defect, `cc_send` the responsible worker the exact problem (file:line, what is
wrong, what you expect), wait for it to finish, and review again. A one-line fix
you may make yourself.

**When a worker asks something** (a question, a permission prompt, a menu):
the boss analyzes it against the user's request and the code and answers it
itself — `cc_send` for text, `cc_key` Up/Down/Enter for menus. Never leave a
worker waiting. Only bring it to the user if it is genuinely their decision
(scope change, risky/irreversible actions, publishing, deleting data, money,
credentials).

**Pick the worker model by task**, via `cc_start` `model`, or switch a running
worker with `cc_send "/model <name>"` when the task changes:
| Model | Use for |
|---|---|
| `haiku` | search/grep, reading and summarizing code, simple mechanical edits, renames, running a known command |
| `sonnet` | normal feature work, bug fixes, writing tests, refactors, build/test fix loops |
| `opus` | hard debugging, architecture/design, tricky cross-module changes, security-sensitive code, anything sonnet failed at |
Start cheap and escalate (haiku → sonnet → opus) if a worker struggles or the
result fails review.

**Unattended by default.** Assume the user gave the task and left. Run the whole
loop — start workers, answer them, final review, fixes — in one go without
stopping to ask "should I continue?".
- At the start of any task that uses workers, ask the host to keep the PC awake
  (`mcp__ccd_host__request_keep_awake`) for the expected duration.
- Never end your turn while a worker is still working: keep looping `cc_wait`.
  Keep context small — read `cc_screen` only when a worker is idle, not on every
  poll.
- If a worker is stuck (same error 3 times, no progress for ~15 min), escalate its
  model or re-brief it; if still stuck, stop it and report.
- A decision only the user can make (scope change, deleting data, publishing,
  credentials, money): send a push notification (`PushNotification`) with the
  one question, keep every other worker going, and leave that part undone rather
  than guessing.
- Do not commit or push unless the task said so.
- When everything is finished and reviewed (or blocked), send a push
  notification with a one-line result, then write the final summary: what each
  worker did, review result, test/build status, anything left for the user.

Other controls: `cc_list` (running workers), `cc_status`, `cc_key ShiftTab`
(cycle permission mode), `cc_cli` (`claude mcp …` / `claude plugin …`),
`cc_settings_get/set`, `cc_permission`. Tool details:
the plugin README.
