---
'agent-do': patch
---

`delegate_task` frames a worker's result before the master sees it. A worker is a separate agent whose context is built from whatever it read, so its output is third-party content arriving in the highest-trust position in the prompt. It now goes through the same boundary wrapping as MCP responses: a `<tool_output>` frame the content cannot close, prompt-injection markers redacted, and a size cap, with the byte and redaction counts reported in the tool result's `data`. The failure path is framed the same way, because a worker's error message can quote what it read on the way down.
