---
'agent-do': patch
---

The suite map now honours a `// @reads <glob>` declaration in a suite, so a test that inspects source files as text
(a stdout-safety invariant, a secret scan, an import rule) is selected whenever one of those files changes. Before
this, such a suite was invisible to affected-only selection: the fast gate could PASS while the invariant was
broken, because the import graph cannot see a `readFileSync` (agent-do-9im).
