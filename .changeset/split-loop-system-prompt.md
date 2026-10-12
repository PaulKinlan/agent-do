---
'agent-do': patch
---

Internal refactor: system-prompt assembly (`buildSystemPrompt`) moved out of `src/loop.ts` into
`src/system-prompt.ts`, the fourth step of splitting that file by responsibility. The same commit removes the
imports the earlier tool move left dead in `src/loop.ts` (agent-do-wqr), audited with `tsc --noEmit
--noUnusedLocals`. No behaviour change: the moved function is byte-identical apart from the `export` it needs.
