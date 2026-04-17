# agent-do

Provider-agnostic autonomous agent loop for JavaScript. Built on the [Vercel AI SDK](https://sdk.vercel.ai/), it drives any `LanguageModel` through a tool-use loop until the task is complete.

## Features

- **Provider-agnostic** -- works with any Vercel AI SDK `LanguageModel` (OpenAI, Anthropic, Google, Mistral, Ollama, etc.)
- **Autonomous loop** -- calls tools, reads results, and continues until the model responds without tool calls
- **Streaming and non-streaming** -- `stream()` yields `ProgressEvent`s as an `AsyncIterable`; `run()` returns the final text
- **Built-in file tools** -- `createFileTools()` gives agents read/write/search/delete backed by any `MemoryStore`
- **Skills system** -- install, search, and manage skill definitions that extend the agent's system prompt
- **Lifecycle hooks** -- intercept tool calls, track steps, modify arguments, or halt execution
- **Permission system** -- accept-all, deny-all, or ask mode with per-tool overrides
- **Usage tracking** -- built-in cost estimation for 50+ models with per-run and per-day spending limits
- **Testable** -- `createMockModel()` returns a mock `LanguageModel` with predetermined responses
- **Eval framework** -- `defineEval()` + `runEvals()` to measure agent quality with 13 assertion types, LLM-as-judge, and multi-provider comparison

## Install

```bash
npm install agent-do
```

Peer dependency: `ai` (Vercel AI SDK v6+).

The CLI ships with `@ai-sdk/anthropic`, `@ai-sdk/google`, and `@ai-sdk/openai`
bundled so `npx agent-do` works out of the box. These are declared as optional
peers for library consumers — if you only use one provider, npm won't complain
about the others being missing, but the CLI covers them all.

### Using a different provider

The CLI only knows about `anthropic`, `google`, `openai`, and `ollama`. For
any other provider (Mistral, Groq, Cohere, OpenRouter, Bedrock, xAI, etc.),
install the SDK and use agent-do as a library:

```bash
npm install agent-do @ai-sdk/mistral
```

```ts
import { createAgent } from 'agent-do';
import { createMistral } from '@ai-sdk/mistral';

const agent = createAgent({
  model: createMistral()('mistral-large-latest'),
});
await agent.run('your task');
```

Any Vercel AI SDK `LanguageModel` works — see
[sdk.vercel.ai/providers](https://sdk.vercel.ai/providers) for the full list.

## CLI

Run agents from the command line with zero config:

```bash
# One-shot task
npx agent-do "What is TypeScript?"

# Pipe content as context
cat README.md | npx agent-do "Summarize this"

# Pipe + prompt merged
echo "function add(a, b) { return a + b }" | npx agent-do "Review this code"

# Interactive chat
npx agent-do

# Choose provider and model
npx agent-do --provider google --model gemini-2.5-flash "Hello"

# Create a reusable agent
npx agent-do create code-reviewer --provider anthropic --system "Review code for bugs"

# Run a saved agent by name
npx agent-do run code-reviewer "Review this function"

# List saved agents
npx agent-do list

# Run a custom agent script (.js files, or .ts with tsx loader)
npx agent-do run my-agent.js "Do something"

# Run eval cases
npx agent-do eval evals/basic.ts

# Compare providers
npx agent-do eval evals/ --compare anthropic,google,openai --output json
```

### CLI options

```
npx agent-do [options] [prompt]          One-shot or interactive
npx agent-do run <file> [task]           Run agent script
npx agent-do eval <file|dir> [options]   Run evals

Options:
  --provider <name>      anthropic | google | openai | ollama (default: anthropic)
  --model <id>           Model ID (default: provider-specific)
  --system <prompt>      System prompt
  --cwd <dir>            Working directory for workspace tools (default: cwd)
  --memory <dir>         Memory directory for --with-memory (default: .agent-do/)
  --with-memory          Enable memory tools (agent scratchpad)
  --read-only            Block all writes (workspace + memory)
  --exclude <globs>      Extra deny-list patterns (comma-separated, gitignore-style)
  --include-sensitive    Bypass built-in sensitive-file deny list (.env, .ssh, etc.)
  --max-iterations <n>   Max loop iterations (default: 20)
  --no-tools             Disable all file tools
  --verbose              Show per-step thinking + tool summaries (stderr)
  --show-content         With --verbose: also include each tool's full result
  --json                 JSON output
  --output <fmt>         console | json | csv (eval only)
  --compare <providers>  Compare providers (eval only, comma-separated)
  --concurrency <n>      Parallel eval cases (default: 1)
```

### Tools: workspace vs memory

agent-do splits file access into two distinct concepts so the agent
knows whether it's touching your project or its own notes:

- **Workspace tools** (`read_file`, `write_file`, `list_directory`,
  `grep_file`, `find_files`, `edit_file`, `delete_file`) are enabled by
  default and rooted at `--cwd` (defaults to the current directory).
  This is what most CLI users want — the agent reads and modifies real
  project files.
- **Memory tools** (`memory_read`, `memory_write`, `memory_list`,
  `memory_delete`, `memory_search`) are opt-in via `--with-memory`.
  They give the agent a private, per-agent scratchpad under `--memory`
  (default `.agent-do/`). Use memory when you want the agent to
  remember notes or plans across runs without scribbling on the
  project.

Both respect `--read-only`. To disable all file access, use `--no-tools`.

### Sensitive-file deny list

Workspace tools ship with a gitignore-style deny list that blocks
access to credential material by default:

- **Reads blocked:** `.env*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`,
  `.ssh/**`, `.aws/**`, `.gcloud/**`, `.kube/**`, `.git/objects/**`,
  `.git/hooks/**`.
- **Writes blocked** (above plus): `.git/**`, `node_modules/**`.

Reads of `node_modules/**` and `.git/HEAD` are allowed — the agent can
inspect dependencies and branch state but cannot silently rewrite git
hooks or clobber installed modules.

Layer your own policy on top:

- `--exclude 'secrets/**,*.cred'` — per-invocation patterns.
- `.agent-doignore` at the workspace root — project-scoped, gitignore-
  style file. Merged with the defaults.
- `--include-sensitive` — opt out of the built-in defaults when you
  explicitly want the old fully-open behaviour. `.agent-doignore` and
  `--exclude` still apply.

Blocked operations surface in `--verbose` logs as `[blocked]` entries
with the matched rule; the model sees only that it was blocked (not
the rule name) to avoid letting it probe the policy.

### Tool result layering: model vs user vs programmatic

Every built-in tool returns a structured `ToolResult` with three views:

- **`modelContent`** — the string the LLM sees. File contents are
  wrapped in `<tool_output tool="…" path="…">…</tool_output>` markers,
  capped at 256 KB (`maxReadBytes`), and common prompt-injection
  markers (`ignore previous instructions`, `<system>` tags) are
  replaced with a visible `[redacted prompt-injection marker]`.
- **`userSummary`** — a one-liner for operator logs. Includes real
  paths, byte counts, line counts, match counts, block reasons, errno
  codes.
- **`data`** — structured fields (`path`, `bytes`, `lines`, `truncated`,
  `redactedMarkerCount`, `matchCount`, `hiddenByDenyList`, `rule`, …)
  for programmatic consumers.

In `--verbose` CLI mode you see the `userSummary` + a compact `data`
line on stderr. Full raw tool output is withheld by default so secrets
and large file contents don't leak into CI logs; pass `--show-content`
to include it.

Library consumers who need the full raw payload on `tool-result`
progress events pass `emitFullResult: true` in `AgentConfig`:

```ts
const agent = createAgent({ /* ... */, emitFullResult: true });
for await (const event of agent.stream('review the code')) {
  if (event.type === 'tool-result') {
    console.log(event.summary);            // always present
    console.log(event.data);                // structured, always present
    console.log(event.toolResult);          // only when emitFullResult: true
  }
}
```

Custom tools can return a `ToolResult` directly for full control:

```ts
import { tool } from 'ai';
import type { ToolResult } from 'agent-do';

const myTool = tool({
  description: 'Do a thing',
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ path }): Promise<ToolResult> => ({
    modelContent: 'Short sanitised view for the model',
    userSummary: `[my_tool] ${path} — did a thing`,
    data: { path, widgetCount: 42 },
  }),
});
```

String returns still work and are normalised automatically.

### Piping

Piped stdin is merged with the command-line prompt:

| stdin | prompt | result |
|-------|--------|--------|
| no | `"Hello"` | Task: `"Hello"` |
| `"context"` | no | Task: `"context"` |
| `"context"` | `"Summarize"` | Task: `"Summarize\n\n---\n\ncontext"` |
| no | no | Interactive mode |

## Quick Start

```ts
import { createAgent } from 'agent-do';
import { createMockModel } from 'agent-do/testing';

const model = createMockModel({
  responses: [
    { text: 'The capital of France is Paris.' },
  ],
});

const agent = createAgent({
  id: 'geography',
  name: 'Geography Agent',
  model,
});

const result = await agent.run('What is the capital of France?');
console.log(result); // "The capital of France is Paris."
```

## Streaming

`stream()` returns an `AsyncIterable<ProgressEvent>` that yields events as the agent works:

```ts
import { createAgent } from 'agent-do';
import { createMockModel } from 'agent-do/testing';

const model = createMockModel({
  responses: [
    { toolCalls: [{ toolName: 'lookup', args: { query: 'Paris' } }] },
    { text: 'Paris is the capital of France.' },
  ],
});

const agent = createAgent({
  id: 'geo',
  name: 'Geo',
  model,
  tools: {
    // ... your tools here
  },
});

for await (const event of agent.stream('Tell me about Paris')) {
  switch (event.type) {
    case 'thinking':
      process.stdout.write(event.content);
      break;
    case 'tool-call':
      console.log(`Calling ${event.toolName}`, event.toolArgs);
      break;
    case 'tool-result':
      console.log(`Result from ${event.toolName}:`, event.toolResult);
      break;
    case 'text':
      console.log('Agent says:', event.content);
      break;
    case 'step-complete':
      console.log(`Step ${event.step! + 1} complete`);
      break;
    case 'done':
      console.log('Final answer:', event.content);
      break;
    case 'error':
      console.error('Error:', event.content);
      break;
  }
}
```

### ProgressEvent types

| Type | Description |
|------|-------------|
| `thinking` | Partial text streaming from the model |
| `tool-call` | The model is calling a tool (`toolName`, `toolArgs`) |
| `tool-result` | A tool returned a result (`toolName`, `toolResult`) |
| `text` | Final text output for a step |
| `step-complete` | An iteration of the loop finished |
| `done` | The agent completed its task |
| `error` | Something went wrong or limits were exceeded |

## Multiple Agents

Create multiple agents with different models, tools, and system prompts:

```ts
import { createAgent } from 'agent-do';
import { createAnthropic } from '@ai-sdk/anthropic';

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const assistant = createAgent({
  id: 'assistant',
  name: 'Assistant',
  model: anthropic('claude-sonnet-4-6'),
  systemPrompt: 'You are a helpful assistant.',
});

const researcher = createAgent({
  id: 'researcher',
  name: 'Researcher',
  model: anthropic('claude-haiku-4-5'), // cheaper model for research
  systemPrompt: 'You are a research assistant. Be thorough.',
});

// Each agent has its own conversation context
const answer = await assistant.run('Hello!');
const research = await researcher.run('Find info about TypeScript');
```

## Tools

Define tools using the Vercel AI SDK's `tool()` function:

```ts
import { createAgent } from 'agent-do';
import { createMockModel } from 'agent-do/testing';
import { tool } from 'ai';
import { z } from 'zod';

const agent = createAgent({
  id: 'math',
  name: 'Math Agent',
  model: createMockModel({
    responses: [
      { toolCalls: [{ toolName: 'add', args: { a: 2, b: 3 } }] },
      { text: 'The sum of 2 and 3 is 5.' },
    ],
  }),
  tools: {
    add: tool({
      description: 'Add two numbers',
      inputSchema: z.object({
        a: z.number(),
        b: z.number(),
      }),
      execute: async ({ a, b }) => `${a + b}`,
    }),
  },
});

const result = await agent.run('What is 2 + 3?');
```

The agent loops automatically: it calls tools, feeds results back to the model, and continues until the model responds with text only (no tool calls) or hits `maxIterations` (default: 20).

## File Tools

`createFileTools()` generates a set of file-manipulation tools backed by any `MemoryStore`:

```ts
import { createAgent, createFileTools, InMemoryMemoryStore } from 'agent-do';
import { createMockModel } from 'agent-do/testing';

const store = new InMemoryMemoryStore();
const fileTools = createFileTools(store, 'agent-1');

const agent = createAgent({
  id: 'writer',
  name: 'Writer',
  model: createMockModel({
    responses: [
      { toolCalls: [{ toolName: 'write_file', args: { path: 'hello.txt', content: 'Hello!' } }] },
      { text: 'File written.' },
    ],
  }),
  tools: fileTools,
});

await agent.run('Create a hello.txt file');
```

The generated tools are:

| Tool | Description |
|------|-------------|
| `read_file` | Read a file's contents |
| `write_file` | Write content to a file (creates parent dirs) |
| `edit_file` | Find-and-replace in a file (match must be unique) |
| `list_directory` | List files and directories at a path |
| `delete_file` | Delete a file |
| `grep_file` | Search for a text pattern across files |
| `find_files` | Recursively list all files from a path |

## MemoryStore

The `MemoryStore` interface abstracts file storage for agents. Two implementations are included:

- **`InMemoryMemoryStore`** — for testing and prototyping (data lost on exit)
- **`FilesystemMemoryStore`** — persists to the local filesystem (survives restarts)

```ts
import { FilesystemMemoryStore, createFileTools, createAgent } from 'agent-do';

const store = new FilesystemMemoryStore('./agent-data');
const agent = createAgent({
  id: 'my-agent',
  name: 'My Agent',
  model: model as any,
  tools: createFileTools(store, 'my-agent'),
});
// Files persist at ./agent-data/my-agent/
```

### Security: FilesystemMemoryStore

> **Warning:** `FilesystemMemoryStore` gives the agent read/write access to the
> specified directory. The agent decides what files to create and modify. Use
> `readOnly: true` to restrict to read-only access, or `onBeforeWrite` to
> approve each write operation.

```ts
// Read-only mode — agent can read but not create/modify/delete
const readOnlyStore = new FilesystemMemoryStore('./data', { readOnly: true });
```

```ts
// Write confirmation — approve each operation (sync or async)
const guardedStore = new FilesystemMemoryStore('./data', {
  onBeforeWrite: (agentId, canonicalPath, operation) => {
    console.log(`Agent ${agentId} wants to ${operation}: ${canonicalPath}`);
    // Return true to allow, false to block
    // The path is canonicalized — ../traversal is resolved before this callback
    return true;
  },
});
```

For other backends, implement the interface:

```ts
interface MemoryStore {
  read(agentId: string, path: string): Promise<string>;
  write(agentId: string, path: string, content: string): Promise<void>;
  append(agentId: string, path: string, content: string): Promise<void>;
  delete(agentId: string, path: string): Promise<void>;
  list(agentId: string, path?: string): Promise<FileEntry[]>;
  mkdir(agentId: string, path: string): Promise<void>;
  exists(agentId: string, path: string): Promise<boolean>;
  search(agentId: string, pattern: string, path?: string): Promise<Array<{ path: string; line: string }>>;
}
```

### Custom implementations

See [`examples/08-custom-memory-store.ts`](examples/08-custom-memory-store.ts) for complete patterns for:
- **Node.js filesystem** (`fs`)
- **AWS S3** (`@aws-sdk/client-s3`)
- **Google Firestore** (`@google-cloud/firestore`)
- **SQLite** (`better-sqlite3`)

## Conversation History

Pass previous conversation turns to maintain context:

```ts
import { createAgent, type ConversationMessage } from 'agent-do';

const history: ConversationMessage[] = [];

// First turn
const r1 = await agent.run('My name is Alice', undefined, history);
history.push({ role: 'user', content: 'My name is Alice' });
history.push({ role: 'assistant', content: r1 });

// Second turn — agent remembers the name
const r2 = await agent.run('What is my name?', undefined, history);
// r2 = "Your name is Alice."
```

## Skills

Skills extend an agent's system prompt with additional instructions. They can be installed, removed, searched, and managed through a `SkillStore`.

### Defining a skill

```ts
import type { Skill } from 'agent-do';

const skill: Skill = {
  id: 'code-review',
  name: 'Code Review',
  description: 'Reviews code for quality and best practices',
  content: `When reviewing code:
- Check for error handling
- Look for security issues
- Suggest performance improvements`,
};
```

### Using InMemorySkillStore

```ts
import { createAgent, InMemorySkillStore } from 'agent-do';
import { createMockModel } from 'agent-do/testing';

const skills = new InMemorySkillStore();
await skills.install({
  id: 'code-review',
  name: 'Code Review',
  description: 'Reviews code for quality',
  content: 'When reviewing code, check for errors and suggest improvements.',
});

const agent = createAgent({
  id: 'reviewer',
  name: 'Reviewer',
  model: createMockModel({ responses: [{ text: 'LGTM' }] }),
  skills,
});
```

When a `SkillStore` is provided, the agent gets:
- Installed skill content injected into the system prompt
- Auto-generated tools: `search_skills`, `install_skill`, `list_skills`, `remove_skill`

### Parsing SKILL.md files

```ts
import { parseSkillMd } from 'agent-do';

const skill = parseSkillMd(`---
name: My Skill
description: Does useful things
author: Alice
version: 1.0.0
---

Instructions for the skill go here.
`);

console.log(skill.name);    // "My Skill"
console.log(skill.content); // "Instructions for the skill go here."
```

### SkillStore interface

Implement `SkillStore` for custom backends (database, filesystem, API):

```ts
interface SkillStore {
  list(): Promise<Skill[]>;
  get(skillId: string): Promise<Skill | undefined>;
  install(skill: Skill): Promise<void>;
  remove(skillId: string): Promise<void>;
  search(query: string): Promise<Array<{ id: string; name: string; description: string; url?: string }>>;
}
```

## Lifecycle Hooks

Hooks let you observe and control the agent loop. All hooks are optional and async.

```ts
import { createAgent } from 'agent-do';
import { createMockModel } from 'agent-do/testing';

const agent = createAgent({
  id: 'hooked',
  name: 'Hooked Agent',
  model: createMockModel({ responses: [{ text: 'Done.' }] }),
  hooks: {
    // Called before each tool execution. Return a HookDecision to allow/deny/modify.
    onPreToolUse: async ({ toolName, args, step }) => {
      console.log(`Step ${step}: about to call ${toolName}`);
      // Return { decision: 'deny', reason: 'not allowed' } to block
      // Return { decision: 'allow', modifiedArgs: { ... } } to modify input
      return { decision: 'allow' };
    },

    // Called after each tool execution.
    onPostToolUse: async ({ toolName, args, result, step, durationMs }) => {
      console.log(`${toolName} took ${durationMs}ms`);
    },

    // Called at the start of each loop iteration. Return 'stop' to halt.
    onStepStart: async ({ step, totalSteps, tokensSoFar, costSoFar }) => {
      if (costSoFar > 1.0) {
        return { decision: 'stop', reason: 'Too expensive' };
      }
    },

    // Called after each loop iteration completes.
    onStepComplete: async ({ step, hasToolCalls, text }) => {
      console.log(`Step ${step} done, has tools: ${hasToolCalls}`);
    },

    // Called when the entire run finishes.
    onComplete: async ({ result, totalSteps, usage, aborted }) => {
      console.log(`Finished in ${totalSteps} steps, cost: $${usage.totalCost.toFixed(4)}`);
    },

    // Called after each step's usage is recorded.
    onUsage: async (record) => {
      console.log(`Step ${record.step}: ${record.inputTokens}in/${record.outputTokens}out, $${record.estimatedCost.toFixed(4)}`);
    },
  },
});
```

### HookDecision

Returned from `onPreToolUse` and `onStepStart`:

```ts
interface HookDecision {
  decision: 'allow' | 'deny' | 'ask' | 'stop' | 'continue';
  reason?: string;
  modifiedArgs?: unknown; // Only for onPreToolUse: replace the tool's input
}
```

## Permissions

Control which tools the agent can call.

```ts
import { createAgent } from 'agent-do';
import { createMockModel } from 'agent-do/testing';

const agent = createAgent({
  id: 'safe',
  name: 'Safe Agent',
  model: createMockModel({ responses: [{ text: 'Done.' }] }),
  permissions: {
    // Base mode: 'accept-all' | 'deny-all' | 'ask'
    mode: 'ask',

    // Per-tool overrides: 'always' | 'ask' | 'never'
    tools: {
      read_file: 'always',   // Always allowed, even in deny-all mode
      delete_file: 'never',  // Always blocked, even in accept-all mode
      write_file: 'ask',     // Falls through to onPermissionRequest
    },

    // Called when mode is 'ask' or a tool's level is 'ask'
    onPermissionRequest: async ({ toolName, args }) => {
      console.log(`Allow ${toolName}?`, args);
      return true; // or false to deny
    },
  },
});
```

### Permission evaluation order

1. If mode is `accept-all`, allow (but still check per-tool `never` overrides)
2. If mode is `deny-all`, deny (but still check per-tool `always` overrides)
3. Check per-tool override: `always` -> allow, `never` -> deny
4. If `ask` or no override: call `onPermissionRequest` (defaults to allow if no callback)

## Usage Tracking

Track token usage and costs across agent runs with built-in pricing for 50+ models.

```ts
import { createAgent } from 'agent-do';
import { createMockModel } from 'agent-do/testing';

const agent = createAgent({
  id: 'tracked',
  name: 'Tracked',
  model: createMockModel({ responses: [{ text: 'Hi' }] }),
  usage: {
    enabled: true,
    limits: {
      perRun: 0.50,  // $0.50 max per run
      perDay: 5.00,  // $5.00 max per day
    },
    // Called when a limit is exceeded. Return true to continue anyway.
    onLimitExceeded: async ({ type, spent, limit }) => {
      console.warn(`${type} limit exceeded: $${spent.toFixed(2)} / $${limit.toFixed(2)}`);
      return false; // stop the run
    },
    // Optional: override built-in pricing
    pricing: {
      'my-custom-model': { input: 1.0, output: 3.0 }, // per 1M tokens
    },
  },
});
```

### UsageTracker class

For standalone usage tracking outside of `createAgent`:

```ts
import { UsageTracker, estimateCost, DEFAULT_PRICING } from 'agent-do';

const tracker = new UsageTracker({
  perRunLimit: 1.0,
});

// Record a step
const record = tracker.record(0, 'claude-sonnet-4-6', 1000, 500);
console.log(record.estimatedCost); // cost based on built-in pricing

// Get summary
const summary = tracker.getSummary();
console.log(summary.totalCost, summary.totalInputTokens, summary.totalOutputTokens);

// Check limits
const ok = await tracker.checkLimits(); // false if limit exceeded

// Standalone cost estimation
const cost = estimateCost('gpt-4o', 10000, 5000);
```

## Testing

`createMockModel()` returns a mock `LanguageModel` compatible with the Vercel AI SDK. It uses predetermined responses so you can test agent behavior without API keys.

```ts
import { createAgent } from 'agent-do';
import { createMockModel } from 'agent-do/testing';
import { tool } from 'ai';
import { z } from 'zod';

// Simulate a multi-step agent run: tool call -> final answer
const model = createMockModel({
  responses: [
    // Step 1: model calls a tool
    { toolCalls: [{ toolName: 'get_weather', args: { city: 'London' } }] },
    // Step 2: model responds with text (ends the loop)
    { text: 'The weather in London is rainy.' },
  ],
  modelId: 'test-model',
  inputTokensPerCall: 100,
  outputTokensPerCall: 50,
});

const agent = createAgent({
  id: 'test',
  name: 'Test',
  model,
  tools: {
    get_weather: tool({
      description: 'Get weather for a city',
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => `${city}: rainy, 12C`,
    }),
  },
});

const result = await agent.run('Weather in London?');
// result === 'The weather in London is rainy.'
```

### MockModelOptions

| Option | Default | Description |
|--------|---------|-------------|
| `responses` | (required) | Array of `MockResponse` objects, used in order |
| `modelId` | `'mock-model'` | Model ID for logging |
| `provider` | `'mock-provider'` | Provider name for logging |
| `inputTokensPerCall` | `10` | Simulated input tokens per call |
| `outputTokensPerCall` | `20` | Simulated output tokens per call |

## Eval Framework

Define eval cases to measure agent quality, compare providers, and catch regressions.

```ts
import { defineEval, runEvals } from 'agent-do/eval';
import { createAnthropic } from '@ai-sdk/anthropic';

const anthropic = createAnthropic();

const suite = defineEval({
  name: 'my-assistant-eval',
  model: anthropic('claude-haiku-4-5'),
  systemPrompt: 'You are a helpful assistant.',
  cases: [
    {
      name: 'knows capitals',
      input: 'What is the capital of France?',
      assert: [
        { type: 'contains', value: 'Paris' },
        { type: 'not-contains', value: 'London' },
      ],
    },
    {
      name: 'saves notes correctly',
      input: 'Save a note that my name is Alice.',
      assert: [
        { type: 'tool-called', tool: 'write_file' },
        { type: 'file-contains', path: 'memories/user.md', value: 'Alice' },
        { type: 'max-steps', max: 5 },
        { type: 'max-cost', maxUsd: 0.05 },
      ],
    },
  ],
});

const result = await runEvals(suite);
// Console output:  ✓ PASS  knows capitals  ($0.0012, 800ms, 1 steps)
//                  ✓ PASS  saves notes correctly  ($0.0035, 2100ms, 2 steps)
```

### Assertion types

| Type | Description |
|------|-------------|
| `contains` | Response text contains a string |
| `not-contains` | Response does NOT contain a string |
| `regex` | Response matches a regex pattern |
| `json-schema` | Response is valid JSON matching a schema |
| `tool-called` | A specific tool was called during execution |
| `tool-not-called` | A specific tool was NOT called |
| `tool-args` | Tool was called with specific arguments (partial match) |
| `file-exists` | A file was created in the memory store |
| `file-contains` | A file in the store contains a string |
| `max-steps` | Agent completed in N or fewer steps |
| `max-cost` | Agent completed within a cost budget (USD) |
| `llm-rubric` | Another LLM scores the response against a rubric |
| `custom` | Custom function receives the full result |

### Multi-provider comparison

```ts
const result = await runEvals(suite, {
  providers: [
    { name: 'anthropic', model: anthropic('claude-sonnet-4-6') },
    { name: 'google', model: google('gemini-2.5-flash') },
    { name: 'openai', model: openai('gpt-4.1-mini') },
  ],
});
// Prints a comparison table with pass rate, cost, and latency per provider
```

### LLM-as-judge

```ts
{
  name: 'explains clearly',
  input: 'Explain quantum computing to a 10 year old',
  assert: [
    {
      type: 'llm-rubric',
      rubric: 'The explanation should be simple, use analogies, avoid jargon.',
      score: 'pass-fail', // or '1-5'
    },
  ],
}
```

### Output formats

```ts
// Console output (default)
await runEvals(suite);

// JSON (for CI/dashboards)
await runEvals(suite, { output: 'json' });

// CSV (for spreadsheets)
await runEvals(suite, { output: 'csv' });

// Silent (programmatic use)
const result = await runEvals(suite, { output: 'silent' });
```

## API Reference

### Main exports (`agent-do`)

| Export | Type | Description |
|--------|------|-------------|
| `createAgent` | `(config: AgentConfig) => Agent` | Create an agent with `run()`, `stream()`, and `abort()` |
| `runAgentLoop` | `(config, task, context?) => Promise<RunResult>` | Run the loop directly (lower-level) |
| `streamAgentLoop` | `(config, task, context?) => AsyncGenerator<ProgressEvent>` | Stream the loop directly (lower-level) |
| `createFileTools` | `(store, agentId) => ToolSet` | Create file tools backed by a MemoryStore |
| `createSkillTools` | `(store: SkillStore) => ToolSet` | Create skill management tools |
| `buildSkillsPrompt` | `(skills: Skill[]) => string` | Build a system prompt section from skills |
| `parseSkillMd` | `(content, id?) => Skill` | Parse a SKILL.md with YAML frontmatter |
| `InMemorySkillStore` | class | In-memory reference implementation of SkillStore |
| `InMemoryMemoryStore` | class | In-memory store (testing/prototyping) |
| `FilesystemMemoryStore` | class | Node.js filesystem store (persistent) |
| `createOrchestrator` | `(config) => Orchestrator` | Create a multi-agent orchestrator |
| `evaluatePermission` | `(toolName, args, config) => Promise<boolean>` | Evaluate a permission check |
| `UsageTracker` | class | Track usage and costs within a run |
| `estimateCost` | `(model, input, output, pricing?) => number` | Estimate cost in USD |
| `DEFAULT_PRICING` | `PricingTable` | Built-in pricing for 50+ models |

### Test exports (`agent-do/testing`)

| Export | Type | Description |
|--------|------|-------------|
| `createMockModel` | `(options: MockModelOptions) => LanguageModel` | Create a mock model for testing |

### Key types

| Type | Description |
|------|-------------|
| `AgentConfig` | Full agent configuration (model, tools, hooks, permissions, usage) |
| `Agent` | Agent instance with `id`, `name`, `run()`, `stream()`, `abort()` |
| `ProgressEvent` | Event emitted during streaming |
| `RunResult` | Result of `run()` with text, usage, steps, aborted flag |
| `AgentHooks` | Lifecycle hook callbacks |
| `PermissionConfig` | Permission mode, per-tool overrides, callback |
| `Skill` / `SkillStore` | Skill definition and storage interface |
| `RunUsage` / `UsageRecord` | Usage summary and per-step records |
| `HookDecision` | Return value from hooks to control execution |
| `PricingTable` | Model pricing lookup (per 1M tokens) |
| `MemoryStore` | Storage interface for agent file operations |
| `FileEntry` | File/directory entry from `list()` |
| `ConversationMessage` | User/assistant message for conversation history |
| `Orchestrator` / `OrchestratorConfig` | Multi-agent orchestration types |
| `BuildSystemPromptOptions` | Options for the prompt builder |
| `SectionFn` | Function that returns a prompt section string |
| `PromptTemplate` | Named template with ordered section list |

### Eval exports (`agent-do/eval`)

| Export | Type | Description |
|--------|------|-------------|
| `defineEval` | `(config: EvalSuiteConfig) => EvalSuiteConfig` | Define an eval suite (type-safe helper) |
| `runEvals` | `(suite, options?) => Promise<EvalResult>` | Run an eval suite and return results |
| `evaluateAssertion` | `(assertion, result, judgeModel?) => Promise<AssertionResult>` | Evaluate a single assertion |
| `EvalSuiteConfig` | type | Eval suite definition (name, model, cases) |
| `EvalCase` | type | Single eval test case (input, assertions) |
| `Assertion` | type | Union of all 13 assertion types |
| `EvalResult` | type | Full eval result with provider breakdowns |
| `CaseResult` | type | Result of a single eval case |

### Prompt exports (`agent-do/prompts`)

| Export | Type | Description |
|--------|------|-------------|
| `buildSystemPrompt` | function | Compose a system prompt from templates, sections, and variables |
| `interpolate` | function | Simple `{{variable}}` replacement |
| `builtinTemplates` | object | Preconfigured templates: assistant, coder, researcher, reviewer, writer, planner |
| `builtinSections` | object | Reusable sections: identity, memoryManagement, fileTools, efficiency, etc. |
| `roleSections` | object | Role-specific sections: codingApproach, researchApproach, etc. |

### Store exports (`agent-do/stores`)

| Export | Description |
|--------|-------------|
| `MemoryStore` | Storage interface (type) |
| `FileEntry` | File entry type |

### Store implementations

| Export | Import path | Description |
|--------|-------------|-------------|
| `InMemoryMemoryStore` | `agent-do` | In-memory store for testing/prototyping (data lost on exit) |
| `FilesystemMemoryStore` | `agent-do` | Node.js filesystem store (persistent, path-traversal safe) |

## Examples

The [`examples/`](examples/) directory contains runnable examples:

| # | File | Description |
|---|------|-------------|
| 1 | [`01-basic-agent.ts`](examples/01-basic-agent.ts) | Simplest possible agent |
| 2 | [`02-agent-with-tools.ts`](examples/02-agent-with-tools.ts) | Custom tools (weather, calculator) |
| 3 | [`03-agent-with-memory.ts`](examples/03-agent-with-memory.ts) | File tools with InMemoryMemoryStore |
| 4 | [`04-lifecycle-hooks.ts`](examples/04-lifecycle-hooks.ts) | Hooks for monitoring and control |
| 5 | [`05-multi-provider.ts`](examples/05-multi-provider.ts) | Anthropic, Google, OpenAI, Ollama |
| 6 | [`06-conversation-history.ts`](examples/06-conversation-history.ts) | Multi-turn conversations |
| 7 | [`07-multi-agent-orchestration.ts`](examples/07-multi-agent-orchestration.ts) | Master + worker agents |
| 8 | [`08-custom-memory-store.ts`](examples/08-custom-memory-store.ts) | Patterns for S3, Firestore, SQLite, filesystem |
| 9 | [`09-skills.ts`](examples/09-skills.ts) | Skills system |
| 10 | [`10-testing.ts`](examples/10-testing.ts) | Testing with createMockModel |
| 11 | [`11-filesystem-store.ts`](examples/11-filesystem-store.ts) | Persistent filesystem storage — explore the created files |
| 12 | [`12-prompt-builder.ts`](examples/12-prompt-builder.ts) | Composable system prompts from templates + sections + variables |
| 13 | [`13-eval-framework.ts`](examples/13-eval-framework.ts) | Eval framework — define cases, assert quality, compare providers |

Run any example: `npx tsx examples/01-basic-agent.ts`

## License

Apache 2.0
