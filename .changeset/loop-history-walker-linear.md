---
'agent-do': patch
---

Stale tool-output redaction no longer goes quadratic on malformed input. `redactToolOutputBlocksInString` searched backwards for each block's closing tag, so a history body of M `<tool_output>` openers with no closers cost O(M·N): 20,000 openers took 1.5 s and 40,000 took 9.7 s. Closing-tag positions are now collected once and looked up by binary search, which brings the same inputs to ~8 ms and ~21 ms with identical output.
