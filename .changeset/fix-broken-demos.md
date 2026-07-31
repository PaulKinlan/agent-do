---
"agent-do": patch
---

Repair all five demos in `demos/`, which had been failing at import since `createFileTools` stopped being exported from the package root in #98. They now use `createWorkspaceTools`, the documented replacement, which keeps the same tool names (`read_file`, `write_file`, `grep_file`, …) so demo prompts and event handling are unchanged. The code-reviewer demo also drops its hand-rolled read-only store in favour of `createWorkspaceTools(target, { readOnly: true })`.

Writes now land at the workspace root rather than under a per-agent subdirectory, matching what the demo READMEs already documented. Nothing in `src/` changed; this is a demo-only repair plus a new credential-free CI smoke job that runs every demo up to its API-key check, so a removed or renamed export can't break them unnoticed again.
