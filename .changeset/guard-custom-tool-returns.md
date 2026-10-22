---
'agent-do': minor
---

A tool you register yourself — a web scraper, an HTTP fetch, a database query returning third-party rows — no
longer hands its return value to the model as bare text. Anything that is not already a `ToolResult` is now put
through the same content guards every built-in tool applies: framed in `<tool_output tool="…" source="tool-return">`
boundary tags, injection markers replaced with `[redacted prompt-injection marker]`, forged `</tool_output>` tags
escaped so content cannot close its own frame, and capped at 256 KB. Everything else about the return is unchanged:
`userSummary` keeps the tool's own text, so operator logs stay diagnostic, and `data` gains `guarded`, `truncated`,
`totalBytes`, `redactedMarkerCount` and `neutralisedDelimiterCount`.

Returning a `ToolResult` is unchanged and is the escape hatch: such a result passes through untouched, so a tool
that has already sanitised its own output is not framed twice.

`wrapForModel` and `sanitiseUntrustedText` — the frame/redact/cap helpers the built-in tools use — are now exported,
so a custom tool can apply the same guard inside its own `ToolResult`, or to a payload it cannot wrap without
changing its shape.
