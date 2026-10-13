---
'agent-do': minor
---

The saved-agent listing now validates every agent file before reading a field from it. `listSavedAgents` used a
bare `JSON.parse(content) as SavedAgent` and, on failure, fabricated `{ name } as SavedAgent` — so a corrupt,
hand-edited or planted `.agent-do/agents/*.json` reached the listing unchecked: a non-string `name` threw a
`TypeError` that broke the whole listing, and any other shape was printed as though it were a real config
(a planted `provider` / `systemPrompt` included). It now shares `loadSavedAgent`'s read path — `safeJsonParse`
(drops `__proto__`/`constructor`/`prototype` keys at any depth) plus `SavedAgentSchema`, which is strict about
unknown keys and bounds every field — and reports `(invalid config)` for a file that fails validation, with the
reason written to stderr rather than swallowed.

Fields taken from a file are also stripped of control characters before printing, so a planted file (or a
planted filename) can no longer put terminal escape sequences into `agent-do list` output, and a newline in
a planted name or file content can no longer invent a line that reads as a trusted `[agent-do] …` diagnostic.
The sanitisation covers the diagnostics written to stderr as well as the listing: the path, and the error
message printed with it (an fs error quotes the path; some `JSON.parse` errors quote the content), are both
taken from disk. Diagnostics are assembled as lines with trusted separators, so no value read from a file can
supply a line break of its own.
