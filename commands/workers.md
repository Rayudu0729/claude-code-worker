---
description: List Claude Code Workers, or stop them (/workers stop <name>|all)
argument-hint: "[stop <name>|stop all]"
---

Manage Claude Code Workers with the `cc_*` tools. Arguments: "$ARGUMENTS"

- No arguments: call `cc_list`, then `cc_status` for each worker, and show a short table — name,
  working or idle, cwd, model (from its command), started, last output.
- `stop <name>`: `cc_stop` that worker and confirm it is gone.
- `stop all`: `cc_stop` every worker from `cc_list` and confirm the list is empty.
