---
'agent-do': patch
---

Docs only: the two cross-references left pointing at the wrong module by the `loop.ts` split now name the module
that actually holds the code — `buildSystemPrompt` is in `src/system-prompt.ts` (not `loop.ts`), and
`createSkillTools` is in `src/tools-build.ts` (not "below" in `system-prompt.ts`). No code change.
