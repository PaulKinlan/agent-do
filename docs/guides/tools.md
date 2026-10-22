# Tools Guide

## Vercel AI SDK tool() Basics

Tools in `agent-do` use the Vercel AI SDK's `tool()` function. Each tool needs a description, an input schema (using Zod), and an execute function:

```typescript
import { tool } from 'ai';
import { z } from 'zod';

const myTool = tool({
  description: 'A human-readable description of what the tool does.',
  inputSchema: z.object({
    query: z.string().describe('Search query'),
    limit: z.number().optional().describe('Max results'),
  }),
  execute: async ({ query, limit }) => {
    // Do something and return a result (string or serializable object)
    return `Found ${limit ?? 10} results for "${query}"`;
  },
});
```

Pass tools to `createAgent` via the `tools` config:

```typescript
const agent = createAgent({
  id: 'my-agent',
  name: 'My Agent',
  model: anthropic('claude-sonnet-4-5'),
  tools: {
    search: myTool,
    calculate: calculatorTool,
  },
});
```

## Built-in tool factories

There are three consumer-facing factories. Use whichever fits the
agent's job; they can also be combined.

### Workspace tools — `createWorkspaceTools(workingDir, opts?)`

Project files rooted at a working directory, with a deny-list at the
tool layer (`.env`, `.ssh/**`, etc.).

```typescript
import { createAgent, createWorkspaceTools } from 'agent-do';

const agent = createAgent({
  id: 'file-agent',
  name: 'File Agent',
  model: anthropic('claude-sonnet-4-5'),
  tools: createWorkspaceTools(process.cwd()),
});
```

### Memory tools — `createMemoryTools(store, agentId)`

The agent's private scratchpad backed by any `MemoryStore`.

```typescript
import { createAgent, createMemoryTools, InMemoryMemoryStore } from 'agent-do';

const memoryStore = new InMemoryMemoryStore();

const agent = createAgent({
  id: 'note-taker',
  name: 'Note Taker',
  model: anthropic('claude-sonnet-4-5'),
  tools: createMemoryTools(memoryStore, 'note-taker'),
});
```

### Shell tool — `createShellTool(sandbox)`

A single shell-exec tool wired to a `SandboxApi`. The sandbox is
required — pass an isolating connector for untrusted input, or
`createHostSandbox()` explicitly for host execution (not isolation).
Model-visible output is wrapped in `<tool_output>` markers with
injection-marker redaction. See
[`docs/sandbox.md`](../sandbox.md).

```typescript
import { createAgent, createShellTool, createJustBashSandbox } from 'agent-do';

const sandbox = await createJustBashSandbox();
const agent = createAgent({
  id: 'runner',
  name: 'Runner',
  model: anthropic('claude-sonnet-4-5'),
  tools: createShellTool(sandbox),
});
```

The workspace tools provide six tools:

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents at a given path |
| `write_file` | Write content to a file (creates parent directories) |
| `list_directory` | List files and directories at a path |
| `delete_file` | Delete a file |
| `grep_file` | Search for a text pattern across files |
| `find_files` | Recursively list all files from a starting path |

## Custom Tool Examples

Whatever a custom tool returns, the loop guards it before the model sees it. A bare string (or any JSON-able
value) is framed in `<tool_output tool="…" source="tool-return">`, injection markers are redacted, forged
boundary tags are escaped and the result is capped at 256 KB — the same treatment `read_file` and friends get
(`agent-do-3qb`, [security.md](../security.md#caller-registered-tools-guarded-by-the-loop-not-by-the-tool)).
Your tool's raw text stays in `userSummary` for operator logs. Return a `ToolResult` instead when your tool has
already sanitised its own output: it is passed through untouched.

### Web Scraper Tool

```typescript
const scrape_url = tool({
  description: 'Fetch and return the text content of a web page.',
  inputSchema: z.object({
    url: z.string().url().describe('URL to scrape'),
  }),
  execute: async ({ url }) => {
    const res = await fetch(url);
    const html = await res.text();
    // Strip HTML tags for a simple text extraction
    return html.replace(/<[^>]*>/g, '').slice(0, 5000);
  },
});
```

### Database Query Tool

```typescript
const query_db = tool({
  description: 'Run a read-only SQL query against the database.',
  inputSchema: z.object({
    sql: z.string().describe('SQL query to execute'),
  }),
  execute: async ({ sql }) => {
    if (!sql.trim().toLowerCase().startsWith('select')) {
      return 'Error: Only SELECT queries are allowed.';
    }
    const rows = await db.query(sql);
    return JSON.stringify(rows, null, 2);
  },
});
```

### Shell Command Tool

Don't hand-roll shell execution with `child_process` in a custom tool —
use the built-in `createShellTool(sandbox)` factory (see the Shell tool
section above). It requires an explicit sandbox connector and applies
guards a hand-rolled tool usually misses: `<tool_output>` framing with
prompt-injection redaction, per-stream byte caps, and per-call timeouts
(a request above `maxTimeoutMs`, default 60s, is refused; below the cap
the value is forwarded to the connector, which is expected to enforce
it — the tool deliberately does not race a wall-clock timer).

```typescript
import { createAgent, createShellTool, createJustBashSandbox } from 'agent-do';

// Isolating in-process bash interpreter: no host shell, virtual
// filesystem, network off unless you pass { allowNet: ... }.
const sandbox = await createJustBashSandbox();

const agent = createAgent({
  id: 'runner',
  name: 'Runner',
  model: anthropic('claude-sonnet-4-5'),
  tools: createShellTool(sandbox), // exposes one tool named `bash`
});
```

If you genuinely want commands on the host — e.g. the agent already
runs inside Docker or a microVM that provides isolation — opt in
explicitly with `createHostSandbox()`. It is **not** a security
boundary, and commands get an allowlisted environment, not the parent's
whole `process.env`:

```typescript
import { createShellTool, createHostSandbox } from 'agent-do';

const tools = createShellTool(createHostSandbox());
```

There is no implicit fallback: `createShellTool()` with no sandbox
throws rather than silently handing the model the host shell. See
[`docs/sandbox.md`](../sandbox.md) for connectors, network policy, and
the environment allowlist.

### Custom tools that touch the outside world

The built-in factories frame everything they return to the model. A
custom `tool()` whose `execute` returns a plain string bypasses that
framing, so if your tool handles untrusted text — fetched pages, log
lines, command output, file contents — you own three guards:

1. **Framing.** Keep untrusted content distinguishable from
   instructions: return a `ToolResult` (exported from `agent-do`) with
   a bounded `modelContent` for the model and a short `userSummary`
   for the operator, and delimit quoted content (e.g. fenced in
   markers) rather than interpolating it into instruction-like text.
2. **Bounding.** Cap what you return and mark truncation: the
   built-ins cap reads at 256 KiB and append
   `... [truncated at N bytes of M]` (the shell tool's stdout/stderr
   use the shorter `…[truncated]`). An unbounded return is a
   context-window and cost problem, not just a correctness one.
3. **Environment.** Never spawn host processes with the parent's whole
   `process.env` — that exposes provider keys (`ANTHROPIC_API_KEY`,
   `OPENAI_API_KEY`, …) to anything the model can run. Route execution
   through `createShellTool` with a sandbox connector; the host
   connector forwards only an allowlisted environment.

## Tool Permissions

Every tool call passes through the permission system before execution. Configure permissions per-tool:

```typescript
const agent = createAgent({
  id: 'safe-agent',
  name: 'Safe Agent',
  model: anthropic('claude-sonnet-4-5'),
  tools: {
    read_file: readFileTool,
    write_file: writeFileTool,
    run_command: shellTool,
  },
  permissions: {
    mode: 'ask',
    tools: {
      read_file: 'always',       // Never prompt
      write_file: 'ask',         // Ask via callback
      run_command: 'never',      // Always deny
    },
    onPermissionRequest: async ({ toolName, args }) => {
      console.log(`Agent wants to use ${toolName} with:`, args);
      return true; // or false to deny
    },
  },
});
```

See the [Hooks and Permissions guide](./hooks-and-permissions.md) for the full permission evaluation pipeline.

## Combining Tools with Skills

Tools and skills work together. Skills inject instructions into the system prompt, while tools give the agent executable capabilities. You can also use `createSkillTools()` to let the agent install and manage skills at runtime -- see the [Skills guide](./skills.md).
