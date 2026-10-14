---
'agent-do': patch
---

The workspace deny list now filters grep hits by their **real paths**. The filter previously recovered a
hit's path by re-parsing the rendered `"path: line"` text, so a `:` inside a path truncated it and a
deny-listed file's content reached the model unfiltered and unredacted - `README:notes.key` and
`dir:1/.env` both passed while `read_file` blocked them.

`grep_file` and `memory_search` also now **frame and redact** their output through the shared content guards,
like `read_file`, `memory_read`, the shell tool and the MCP bridge: previously a searched file containing
`ignore previous instructions` or a literal `</tool_output>` reached the model verbatim. Both tools report
their hits structurally in `data.matches`, and the deny-list filter reads those records rather than the
rendered text, so path policy and rendering can no longer disagree.
