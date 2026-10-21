---
'agent-do': minor
---

Sub-agent spend is now visible to parent usage guards instead of being silently dropped (agent-do-5oz).

- `agent.runWithResult(task, context?, history?)` returns the full `RunResult` — text plus the usage ledger — while `run()` still returns just the text. `agent.run()` is now implemented on top of it.
- Slash-command dispatch (`/name args`) reports the **sub-agent's real token and cost usage** in the parent's `RunResult.usage`; it previously reported hardcoded zeros, so a parent's `perRunLimit`/`perDayLimit` reporting never saw what a dispatch spent. The sub's `aborted` flag propagates too.
- `AgentConfig.usage.tracker` accepts a caller-owned `UsageTracker`. Agents sharing one tracker share one budget: every agent's limit checks see the combined spend, and each `RunResult.usage` reports the shared total.
- `createOrchestrator` uses that mechanism automatically: when the master config sets `usage.limits`, one shared tracker (the master's pricing and limits) backs the master and every worker, so a worker can no longer burn past the master's spending guard via `delegate_task`. The delegated tool result also reports the worker's spend in `data.workerUsage` and in its user summary. `orchestrator.runWithResult()` returns the master's full `RunResult` including that combined usage.
- `validateSlashCommands` now also requires `runWithResult` on `slashCommands` values, so a duck-typed stand-in that cannot report usage fails at `createAgent()` time instead of silently accounting zeros. Use `createAgent()` to build sub-agents.
