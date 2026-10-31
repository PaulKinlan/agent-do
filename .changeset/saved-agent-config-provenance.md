---
"agent-do": minor
---

Saved agent configs now need provenance before their `systemPrompt` reaches the system tier. `agent-do create`
records the sha256 of what it wrote; `agent-do run <name>` refuses a config that was never recorded on this machine
(a cloned repository can ship `.agent-do/agents/<name>.json`, and the lookup walks up from the working directory),
and `--trust-agent-config` accepts and remembers the current content. `agent-do list` marks unvetted configs.
