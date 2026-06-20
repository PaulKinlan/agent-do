---
"agent-do": minor
---

Add **scheduled tasks** — declarative cron-driven agent runs with lock-file concurrency (#79). Many useful agents run on a schedule (inbox sweep every 15 min, daily brief at 8am, weekly digest); now that's a first-class primitive instead of hand-rolled cron/systemd per agent.

```bash
npx agent-do scheduled-tasks list        # show configured tasks
npx agent-do scheduled-tasks install     # emit crontab lines for your tasks
npx agent-do scheduled-tasks run <id>    # run one task (lock-protected)
npx agent-do scheduled-tasks status      # last-run times + outcomes
npx agent-do scheduled-tasks start       # foreground loop (dev/test)
```

Tasks live in a JSON file (`<memoryDir>/scheduled-tasks.json`). The production wiring is **system cron**: `install` emits one crontab line per task that calls `scheduled-tasks run <id>`, so the system cron does the timing and agent-do does the safe execution. Every run acquires the #15 file lock, so **overlapping firings skip** and a crashed run is reclaimed after `staleMs` — the cross-process guarantee a scheduler needs and an in-process mutex can't provide. Last-run metadata is recorded in `scheduler-status.json`.

The cron matcher (`matchesCron`) is dependency-free, supports the portable 5-field numeric subset (`*/n`, ranges, lists, Vixie dom/dow OR-semantics), and throws clearly on malformed expressions. New exports: `matchesCron`, `validateScheduledTasks`, `readStatus`/`writeStatus`/`recordRun`, `runScheduledTask`, and types `ScheduledTask`/`ScheduledTasksConfig`/`TaskStatus`. `AgentConfig.scheduledTasks?: ScheduledTask[]` is validated at `createAgent()` time.

Builds directly on #15 Tier 1's file lock. `sessionTarget: 'main'` (persistent conversation) and `wakeMode: 'systemEvent'` (structured wake event) are reserved in v1 — every run is isolated and the payload is treated as the task text; they're follow-ups pending a history store and an event channel.
