---
'agent-do': patch
---

Internal refactor: the per-step usage hook (`buildOnStepEnd`) moved out of `src/loop.ts` into
`src/step-bookkeeping.ts`, the fifth step of splitting that file by responsibility, and it is re-exported from the
loop module so existing importers are unaffected. No behaviour change: the moved function is byte-identical.
