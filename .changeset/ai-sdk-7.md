---
"agent-do": minor
---

Upgrade to AI SDK 7 (`ai@^7.0.44`) and the v4 provider packages (`@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai` at `^4.0.0`).

**This raises the Node floor to 22.** `engines.node` moves from `>=20` to `>=22`, the minimum AI SDK 7 requires, and Node 20 is out of the CI matrix. If you are on Node 20, stay on agent-do 0.6.x until you can upgrade the runtime.

If you construct your own model and pass it as `AgentConfig.model`, you must move to a v4 provider package — a v3 model instance is a `LanguageModelV3` and will not satisfy the v4 `LanguageModel` type. Everything else in agent-do's own surface is unchanged: `createAgent`, the loop, tools, hooks, stores, and every export keep their existing signatures.

Internally the loop moves off the option names AI SDK 7 deprecated — `system` → `instructions`, `onStepFinish` → `onStepEnd`, `result.fullStream` → `result.stream` — so agent-do isn't riding aliases that a future major will remove. The debug middleware moves to `LanguageModelV4Middleware`. A new test asserts the system prompt actually arrives at the provider as a system-role message, so a future rename can't drop it silently.

The upgrade also clears the last outstanding advisory: `@ai-sdk/provider-utils@5` uses `undici@^7.28.0` instead of the `undici@5` that `npm audit` flagged. `npm audit` is now clean.
