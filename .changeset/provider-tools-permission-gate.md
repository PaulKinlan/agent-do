---
'agent-do': minor
---

Provider-executed tools (`--provider-tool`, e.g. Anthropic `bash`/`textEditor`/`computer`, OpenAI `applyPatch`, Google `codeExecution`) are now gated by the permission policy at registration. Previously they bypassed permissions, hooks and tool-call limits entirely because the AI SDK runs them server-side and never calls local `execute`. A provider tool the policy cannot allow without asking (default `ask` mode, or `deny-all`) is now left out of the run entirely, with a warning naming it; allow one explicitly with `--allow <tool>` (bare names expand to the registered `google__googleSearch`-style keys) or run with `--accept-all`. An explicit per-tool `'always'` override in `permissions.tools` does the same for library users.
