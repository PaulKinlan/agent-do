---
'agent-do': patch
---

Add a `agent-do/browser` entry point for environments without Node builtins (GH #139). It exports the real
`runAgentLoop`/`streamAgentLoop`, the pure routine helpers and `InMemoryRoutineStore`, `matchesCron` +
`validateScheduledTasks`, and `mountRemoteMcpServers` for `http`/`sse` MCP transports — with no `node:`
import anywhere in its graph, so a `platform: 'browser'` bundle no longer resolves through `mcp → stdio →
cross-spawn`. The Node-only halves moved to explicit modules (`routines/filesystem.ts`,
`scheduled-tasks/fs.ts`) and are still exported from the package root, so existing imports are unchanged.
