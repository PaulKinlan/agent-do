---
'agent-do': minor
---

Fresh CLI prompt sessions can search the web and fetch page excerpts through
anonymous Parallel Search MCP, without a separate search account or API key.
Connections start only after tool permission checks, with cancellation and a
30-second deadline. Disable the default with `--no-search` or `--no-tools`;
explicit provider tools/options take precedence, and saved agents and scripts
keep their existing tool configuration.
