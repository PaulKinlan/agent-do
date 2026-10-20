---
'agent-do': minor
---

Provider-executed tool calls (`--provider-tool`) are now counted and bounded at the loop level: the loop counts `tool-call` stream parts flagged `providerExecuted` into the `toolLimits` counters, and once the observed run total exceeds `maxToolCalls` the run stops (with `aborted: true` and an error event) instead of letting server-side fan-out continue unbounded. `onPostToolUse` now fires for provider-executed results — with a new `providerExecuted: true` marker and `durationMs: 0` — and `tool-call`/`tool-result` progress events carry `providerExecuted: true`, with `tool-result` events enriched with the normalised structured result. `onPreToolUse` is deliberately not fired for provider-executed calls because its deny/stop decisions cannot be enforced after server-side execution. Pure-local runs keep their existing per-call denial semantics.
