---
'agent-do': patch
---

Internal refactor: the per-run debug surface (`setupDebug`, plus the system-prompt and cache event emitters)
moved out of `src/loop.ts` into `src/debug.ts`, the second step of splitting that file by responsibility. No
behaviour change — the moved functions are byte-identical apart from the `export` they now need.
