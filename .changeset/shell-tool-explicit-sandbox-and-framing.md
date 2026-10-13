---
'agent-do': minor
---

`createShellTool()` now requires a sandbox, and shell output reaches the model framed. The sandbox argument is
how you opt into host execution: `createShellTool(createHostSandbox())` runs commands directly on the host
(same behaviour as before, now explicit), while untrusted input should get an isolating connector such as
`createJustBashSandbox()`. Calling it with no sandbox throws with an actionable message instead of silently
wiring a model-facing tool to the host shell. Shell stdout/stderr is also returned inside
`<tool_output tool="…" command="…">` markers with the same prompt-injection-marker redaction `read_file` and
`memory_read` apply, so command output — a fetched page, a log line, a filename — no longer reaches the model
as unframed text; `ToolResult.data.redactedMarkerCount` reports how many markers were stripped.
