---
"agent-do": minor
---

Add **shellm** — prompt files you run like shell scripts (issue #16). A plain-text prompt with a shebang (`#!/usr/bin/env agent-do`) and optional YAML frontmatter becomes an executable:

```sh
echo '#!/usr/bin/env agent-do
Summarize the git log.' > weekly.shellm
chmod +x weekly.shellm
./weekly.shellm
```

Prompt mode detects a shellm file when the first positional opts in via a `.shellm` extension OR an `agent-do` shebang on line 1 — so `agent-do readme.md` still means the literal prompt "readme.md". Frontmatter sets `provider`/`model`/`system`; piped stdin merges with the file prompt as context. A shellm file is data (never `import()`ed), so it's strictly safer than `--script`, but its contents reach the model — don't run untrusted shellm files.

New `src/cli/shellm.ts` (`parseShellm`, `tryParseShellm`, `readShellmFile`) with a ReDoS-safe frontmatter splitter; sample at `examples/22-shellm.shellm`; README `## Shellm Scripts` section. Saved-agent (`agent:`) wiring and `{{stdin}}` template variables are noted follow-ups.
