---
'agent-do': patch
---

Frame MCP tool failures the same way as successful calls: a rejection from an MCP server - and the message from a server that has been closed - no longer reaches the model as a bare string but inside the `<tool_output>` boundary with injection markers redacted. The raw message stays available to operators in `userSummary` / `data`, together with a count of the markers neutralised.

`wrapForModel` now also neutralises forged `<tool_output>` boundary tags in content, so third-party text cannot close the frame early and have the rest read as instructions from outside the tool output. This applies to every caller (file and memory tools as well as MCP).
