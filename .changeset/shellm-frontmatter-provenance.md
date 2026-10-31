---
"agent-do": minor
---

A shellm file's `system:` frontmatter now needs provenance, like a saved agent config's `systemPrompt`: it replaces
the run's system prompt, and the file can arrive with a cloned repository. The first run of a given file content
requires `--trust-agent-config`, which records the file's hash; later runs of the same content are silent, and
editing the file re-opens the question. The prompt body is not gated — it is the task, not instructions.
