---
'agent-do': patch
---

Add a `agent-do/browser` entry point for environments without Node builtins (GH #139). It exports the real
`runAgentLoop`/`streamAgentLoop`, the pure routine helpers and `InMemoryRoutineStore`, `matchesCron` +
`validateScheduledTasks`, and `mountRemoteMcpServers` for `http`/`sse` MCP transports — with no `node:`
import anywhere in its graph, so a `platform: 'browser'` bundle no longer resolves through `mcp → stdio →
cross-spawn`. The Node-only halves moved to explicit modules (`routines/filesystem.ts`,
`scheduled-tasks/fs.ts`) and are still exported from the package root, so existing imports are unchanged.

A `stdio` MCP server is now rejected explicitly, before any transport is constructed, whenever the runtime cannot
spawn a child process (or when `mountMcpServers` is called with `{ allowStdio: false }`). The check lives in
`mountMcpServers`, so it covers `runAgentLoop` too, not just the browser helper. Previously the browser path only
failed later, inside a bundler-ignored dynamic import, with an error that named neither the server nor the fix.
