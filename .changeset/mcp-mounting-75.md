---
"agent-do": minor
---

MCP (Model Context Protocol) server mounting (closes #75).

agent-do can now mount external MCP servers and expose their tools to the model alongside local tools. Three transports supported: stdio (subprocess), SSE (legacy HTTP long-polling), and streamable HTTP.

New `AgentConfig.mcpServers` option:

```ts
const agent = createAgent({
  model,
  mcpServers: [
    {
      name: 'fs',
      transport: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      },
      allowedTools: ['read_text_file', 'list_directory'],
    },
    {
      name: 'search',
      transport: { type: 'http', url: 'https://example.com/mcp' },
    },
  ],
});
```

### Design

- **Tool namespacing** — discovered tools are renamed `mcp__<server>__<tool>` so two servers exposing a same-named tool don't collide. `namespacedToolName()` exported for use in logs / debug output.
- **Lifecycle handled by the loop** — `runAgentLoop` and `streamAgentLoop` mount servers before starting and close them in a `finally` block. Subprocesses don't leak on abort/error/completion.
- **All-or-nothing mount** — if any server fails to connect, previously-connected servers are closed before the error propagates. No half-mounted state.
- **Optional `allowedTools` filter** — expose only a subset of a server's tools to the model. Useful when a server offers many tools but the agent needs a couple.
- **Permissions + hooks apply uniformly** — MCP tools go through the same `wrapToolWithPermissions` path as local tools, so `onPreToolUse` / `onPostToolUse` fire for them, permissions gate them, and `toolLimits` count them.
- **Content flattening** — MCP tool responses can be mixed content (text, images, embedded resources). Today we flatten to concatenated text with short descriptors for non-text parts (`[image: image/png]`, `[resource: <uri>]`).

### New exports

- `mountMcpServers(configs)` → `{ tools, toolOrigins, close }` — standalone mounting helper for callers who don't want the loop's lifecycle management.
- `namespacedToolName(server, tool)` — build the namespaced name without duplicating the `mcp__` convention.
- `MCP_TOOL_PREFIX = 'mcp__'` — the stable prefix constant.
- Types: `McpServerConfig`, `McpTransportConfig`, `MountedMcpServers`.

### Dependencies

Adds `@modelcontextprotocol/sdk` as a runtime dependency.

Example: see `examples/14-mcp.ts` — mounts the filesystem reference server against a sandbox directory.
