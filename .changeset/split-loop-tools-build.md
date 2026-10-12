---
'agent-do': patch
---

Internal refactor: tool construction — the permission/hook wrapper and `buildTools()` — moved out of
`src/loop.ts` into `src/tools-build.ts`, the third step of splitting that file by responsibility. No behaviour
change: the moved code is byte-identical apart from the `export` keywords it needs.
