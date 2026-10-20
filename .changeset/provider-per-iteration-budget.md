---
'agent-do': patch
---

Provider-executed tool calls no longer consume the local per-iteration tool budget: the `maxToolCallsPerIteration` cap for local tools stays local-only, so a legitimate local call is never denied because provider calls happened in the same model response (previously order-dependent). The provider side of the cap is now enforced post-hoc — a model response whose provider-executed calls alone exceed `maxToolCallsPerIteration` stops the run after that step, mirroring the run-level `maxToolCalls` behaviour. Docs updated to describe both budgets accurately.
