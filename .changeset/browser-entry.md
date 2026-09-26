---
'agent-do': minor
---

Add browser-safe entry point `agent-do/browser` and `browser` export condition, separating Node-only helpers (stdio MCP, filesystem stores, host sandbox, file locking) from the pure agent loop, remote MCP (SSE/HTTP), routine/cron helpers, and memory tools.
