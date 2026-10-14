---
'agent-do': patch
---

Names in directory and memory listings are rendered with control characters escaped, so a filename containing
a newline can no longer forge an entry line: `list_directory`, `find_files` and `memory_list` render `\n` as the
two characters `\n`. The deny-list filter also reads entries from structured `data.entries` instead of
re-parsing the rendered lines - the same serializer/policy desync that `agent-do-2rm` fixed for grep hits.
