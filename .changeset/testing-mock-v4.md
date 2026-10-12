---
'agent-do': patch
---

`createMockModel` (exported as `agent-do/testing`) now returns an AI SDK V4 mock model and emits V4 stream
parts: `finishReason` is `{ unified, raw }` and usage is nested per direction
(`inputTokens: { total, noCache, cacheRead, cacheWrite }`, `outputTokens: { total, text, reasoning }`).

The retired V3 shape made the SDK skip executing the tool calls the mock reported — silently, with no error at
all — because it gates tool execution on `finishReason.unified`. That only surfaced later as
`MissingToolResultsError` from the loop's next step, which is what broke 24 tests across 7 suites on
`ai` 7.0.137. Consumers using `createMockModel` in their own tests now get a mock that drives the SDK's real
V4 tool-call path, matching the V4 provider packages this library depends on.
