---
description: List Claude Code Workers, or stop them (/workers stop <name>|all)
argument-hint: "[stop <name>|stop all]"
---

Manage Claude Code Workers with the `cc_*` tools. Arguments: "$ARGUMENTS"

- No arguments: call `cc_list` and show a short table — name, state, tokens, role/model, branch, cwd,
  started. If `cc_queue_list` has open tasks, show them below (id, state, depends on, error).
- `stop <name>`: `cc_stop` that worker and confirm it is gone.
- `stop all`: `cc_stop` every worker from `cc_list` and confirm the list is empty.
