---
description: Hand a task to Claude Code Workers and run it unattended (boss mode)
argument-hint: <task description>
---

Run this task unattended as the boss, following the `worker-boss` skill exactly: split it into
worker tasks, start Claude Code Workers with the `cc_*` tools and a model per task, answer their
questions yourself, do the final review only once everything is implemented, then notify and
summarize. Assume I have left.

Task: $ARGUMENTS
