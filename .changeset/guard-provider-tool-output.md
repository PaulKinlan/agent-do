---
'agent-do': patch
---

Provider-native tool results now go through the content guards. `googleSearch`, `urlContext`, Anthropic's
`webSearch_*` / `webFetch_*` and OpenAI's `webSearch` are executed by the provider, so nothing in this process ever
saw their output as a string — the one tool surface that handed raw third-party web content to the model unframed and
unredacted, while file, memory, shell, MCP and orchestrator results were all wrapped.

`buildTools` now installs a `toModelOutput` hook on every tool that is provider-executed, and
`src/tools/provider-output-guard.ts` sanitises the result before the provider converts it back to its wire format:
text results are framed in `<tool_output tool="…" source="provider-native">` with injection markers redacted and the
byte cap applied; structured results are redacted in place — keys, types and structure preserved so the provider's
output schema still validates, and no truncation, because a capped provider payload is rejected rather than
protected. See "Provider-native tools" in `docs/security.md` for what the guard does not cover.
