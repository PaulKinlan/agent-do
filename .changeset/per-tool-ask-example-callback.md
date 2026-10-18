---
'agent-do': patch
---

Doc fix only: the per-tool `'ask'` example in the hooks-and-permissions guide now supplies the `onPermissionRequest` callback that mode `'ask'` requires (it previously showed a config that is rejected at construction), explains that a per-tool `'ask'` only defers to the callback in `'ask'` mode, and the `allowSkillInstall` doc comment no longer implies `mode: 'ask'` alone is a permission layer.
