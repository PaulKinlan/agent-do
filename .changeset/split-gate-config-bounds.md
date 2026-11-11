---
'agent-do': patch
---

Extracted the gate config-bound tests (readBound, countTraceAssignments, the two kill-window config pins and the readBound behaviour suite) from tests/gates.test.ts into tests/gate-config-bounds.test.ts. `tools/*` now maps to BOTH suites, so a gate script or config change still runs the full gate coverage; test-only amendments to the config pins no longer pay for the whole gate-behaviour suite (~53 s -> single suite). No assertions changed semantics — the tests moved verbatim (agent-do-1o5o).
