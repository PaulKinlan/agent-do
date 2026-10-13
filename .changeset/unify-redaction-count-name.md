---
'agent-do': patch
---

MCP tool results report the injection-marker count under its canonical name, `redactedMarkerCount`, on every
path. The rejection path called it `neutralisedMarkers` - a third name for a quantity that `read_file`,
`grep_file`, the memory tools and the shell tool already reported under the canonical one, so a consumer
parsing `ToolResult.data` had to know which tool produced the result.

Both MCP error paths (a rejection and a closed server) now also carry `truncated` and `totalBytes`, and the
closed path carries the two counts it previously omitted, so every MCP error has one shape. The counts are
documented in `src/tools/types.ts` as canonical and distinct: `redactedMarkerCount` counts injection phrases
redacted, `neutralisedDelimiterCount` counts `<tool_output>` boundary tags escaped.
