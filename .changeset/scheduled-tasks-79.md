---
"agent-do": minor
---

Add scheduled tasks (#79): declarative cron-driven agent runs with
lock-file concurrency.

`AgentConfig.scheduledTasks` accepts an array of `ScheduledTask`
entries (id, cron expression, payload, optional sessionTarget /
wakeMode). Invalid cron expressions or duplicate IDs throw at
`createAgent` time.

New runtime exports on the main entry:

- `runScheduledTask(agent, task, options?)` fires one task now,
  acquiring a per-task lock at `.agent-do/scheduler/<id>.lock` so
  concurrent crontab invocations can't overlap. Stale locks (dead
  PID, same host) are broken automatically.
- `runScheduler(agent, tasks, options?)` runs a foreground loop that
  ticks every minute and fires matching tasks.
- `tickScheduler` / `createSchedulerState` expose the per-tick core
  for tests and custom hosts.
- `parseCron` / `cronMatches` — minimal 5-field cron evaluator.
- `acquireLock` / `releaseLock` / `readLock` — lock file primitives.
- `readStatus` — per-task last-run / duration / failure counts.
- `generateCrontabEntries` — render a crontab block to paste into
  `crontab -e`.

New CLI subcommand: `agent-do scheduled-tasks <run|start|status|install>`.
