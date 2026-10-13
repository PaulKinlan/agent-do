---
'agent-do': patch
---

Stop hiding truncation and boundary escaping from the model and from callers. A connector rejection whose message is longer than the 4 KiB error cap is now clipped with the same `…[truncated]` marker the command streams use, and the result carries `messageBytes` / `messageTruncated`, so a cut-off error can no longer read as a complete one (the old path dropped the tail silently and the 8 KiB backstop could never fire). `read_file`, `memory_read` and MCP failures now also report `neutralisedDelimiterCount`, the number of `<tool_output>` boundary tags escaped in their body, matching the shell tool - the escaping already happened, it just was not reported.
