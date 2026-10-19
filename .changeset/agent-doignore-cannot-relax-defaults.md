---
'agent-do': patch
---

`.agent-doignore` can no longer relax the built-in deny-list or `--exclude` patterns: it may only add restrictions,
and a `!` line in it relaxes nothing but the file's own patterns. The workspace file arrives with the repository, so
a single `!.env` line could previously re-open reads of `.env`, key material and `.git/hooks`. The sanctioned
override stays `--include-sensitive`, which is a command-line flag rather than a file a repository can supply.

An `--exclude` pattern you pass yourself is different: it is your own instruction, so a negation in it
(`--exclude '!.env'`) still re-opens a default, exactly as `--include-sensitive` does. The distinction is provenance
— a rule the workspace supplied may only add (agent-do-54g).
