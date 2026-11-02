---
'agent-do': patch
---

The default write deny list now covers `.husky/**` (any depth). Husky is the modern default git-hook mechanism — it points `core.hooksPath` at `.husky/_`, so scripts written under `.husky/` run on the operator's next commit. That is the same persistence path as `.git/hooks/**`, which was already denied; a file-writing agent could previously rewrite hook execution by writing one directory over. Reads stay allowed, and `--include-sensitive` remains the explicit opt-out (agent-do-60j9).
