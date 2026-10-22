# agent-do API Reference

Complete API reference for the `agent-do` package -- a provider-agnostic autonomous agent loop built on the Vercel AI SDK.

## Core

### `createAgent(config: AgentConfig): Agent`

Create an Agent instance from configuration. Returns an agent with `run()` and `stream()` methods that drive the autonomous agent loop.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `config` | `AgentConfig` | Full agent configuration (see AgentConfig below) |

**Returns:** `Agent`

---

### `runAgentLoop(config: AgentConfig, task: string, context?: string): Promise<RunResult>`

Run the agent loop directly and return the final result. This is the lower-level API that `Agent.run()` wraps.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `config` | `AgentConfig` | Agent configuration |
| `task` | `string` | The task/prompt to execute |
| `context` | `string` | Optional additional context appended to system prompt |

**Returns:** `Promise<RunResult>`

---

### `streamAgentLoop(config: AgentConfig, task: string, context?: string): AsyncGenerator<ProgressEvent>`

Stream the agent loop, yielding progress events as the agent works. This is the lower-level API that `Agent.stream()` wraps.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `config` | `AgentConfig` | Agent configuration |
| `task` | `string` | The task/prompt to execute |
| `context` | `string` | Optional additional context appended to system prompt |

**Returns:** `AsyncGenerator<ProgressEvent>`

---

## Types

### `AgentConfig`

Full configuration for creating an agent.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | `string` | required | Unique agent identifier |
| `name` | `string` | required | Human-readable agent name |
| `model` | `LanguageModel` | required | Vercel AI SDK language model instance |
| `systemPrompt` | `string` | `undefined` | Raw system prompt (e.g. CLAUDE.md content) |
| `tools` | `ToolSet` | `undefined` | Vercel AI SDK tools available to the agent |
| `skills` | `SkillStore` | `undefined` | Skill store for dynamic skill loading |
| `maxIterations` | `number` | `20` | Maximum outer loop iterations |
| `innerStepLimit` | `number` | `5` | Maximum tool calls per single streamText call |
| `hooks` | `AgentHooks` | `undefined` | Lifecycle hooks (see AgentHooks) |
| `permissions` | `PermissionConfig` | `undefined` | Permission configuration for tool calls |
| `usage` | `object` | `undefined` | Usage tracking and spending limits |
| `usage.enabled` | `boolean` | `true` | Whether to track usage |
| `usage.pricing` | `PricingTable` | `DEFAULT_PRICING` | Custom pricing table |
| `usage.limits.perRun` | `number` | `undefined` | Max cost in USD per run |
| `usage.limits.perDay` | `number` | `undefined` | Max cost in USD per day |
| `usage.onLimitExceeded` | `(event) => Promise<boolean>` | `undefined` | Callback when a limit is exceeded. Return `true` to continue anyway. |
| `signal` | `AbortSignal` | `undefined` | Abort signal for cancellation |

---

### `Agent`

Agent instance returned by `createAgent()`.

| Property/Method | Type | Description |
|-----------------|------|-------------|
| `id` | `readonly string` | Agent identifier |
| `name` | `readonly string` | Agent name |
| `run(task, context?)` | `(task: string, context?: string) => Promise<string>` | Run the agent to completion, return final text |
| `stream(task, context?)` | `(task: string, context?: string) => AsyncIterable<ProgressEvent>` | Stream progress events as the agent works |
| `abort()` | `() => void` | Abort the current run |

---

### `ProgressEvent`

Events emitted during agent execution (via `stream()`).

| Field | Type | Description |
|-------|------|-------------|
| `type` | `'thinking' \| 'tool-call' \| 'tool-result' \| 'text' \| 'step-complete' \| 'done' \| 'error'` | Event type |
| `content` | `string` | Text content or status message |
| `toolName` | `string?` | Tool name (for tool-call/tool-result) |
| `toolArgs` | `unknown?` | Tool arguments (for tool-call) |
| `toolResult` | `unknown?` | Tool result (for tool-result) |
| `step` | `number?` | Current step number |
| `totalSteps` | `number?` | Total steps configured |

---

### `RunResult`

Result returned by `runAgentLoop()`.

| Field | Type | Description |
|-------|------|-------------|
| `text` | `string` | Final text output from the agent |
| `usage` | `RunUsage` | Token and cost usage summary |
| `steps` | `number` | Number of steps taken |
| `aborted` | `boolean` | Whether the run was aborted |

---

### `RunUsage`

Usage summary for a single run.

| Field | Type | Description |
|-------|------|-------------|
| `totalInputTokens` | `number` | Total input tokens consumed |
| `totalOutputTokens` | `number` | Total output tokens consumed |
| `totalCost` | `number` | Total estimated cost in USD |
| `steps` | `number` | Number of steps recorded |
| `records` | `UsageRecord[]` | Per-step usage records |

---

### `UsageRecord`

Per-step usage record.

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | `string` | ISO timestamp |
| `step` | `number` | Step number |
| `inputTokens` | `number` | Input tokens for this step |
| `outputTokens` | `number` | Output tokens for this step |
| `estimatedCost` | `number` | Estimated cost in USD |
| `model` | `string` | Model ID used |

---

## Hooks

### `AgentHooks`

Lifecycle hooks fired during agent execution. All hooks are optional.

| Hook | Signature | Description |
|------|-----------|-------------|
| `onPreToolUse` | `(event: PreToolUseEvent) => Promise<HookDecision \| void>` | Called before each tool execution. Return a decision to allow, deny, or modify. |
| `onPostToolUse` | `(event: PostToolUseEvent) => Promise<void>` | Called after each tool execution. |
| `onStepStart` | `(event: StepStartEvent) => Promise<HookDecision \| void>` | Called at the start of each iteration. Return `{ decision: 'stop' }` to halt. |
| `onStepComplete` | `(event: StepCompleteEvent) => Promise<void>` | Called after each iteration completes. |
| `onComplete` | `(event: CompleteEvent) => Promise<void>` | Called when the agent finishes (success or abort). |
| `onUsage` | `(record: UsageRecord) => Promise<void>` | Called after each step's usage is recorded. |

---

### `PreToolUseEvent`

| Field | Type | Description |
|-------|------|-------------|
| `toolName` | `string` | Name of the tool being called |
| `args` | `unknown` | Tool arguments |
| `step` | `number` | Current step number |

### `PostToolUseEvent`

| Field | Type | Description |
|-------|------|-------------|
| `toolName` | `string` | Name of the tool that was called |
| `args` | `unknown` | Tool arguments |
| `result` | `unknown` | Tool result |
| `step` | `number` | Current step number |
| `durationMs` | `number` | Execution time in milliseconds |

### `StepStartEvent`

| Field | Type | Description |
|-------|------|-------------|
| `step` | `number` | Current step number |
| `totalSteps` | `number` | Total steps configured |
| `tokensSoFar` | `number` | Total tokens consumed so far |
| `costSoFar` | `number` | Total cost in USD so far |

### `StepCompleteEvent`

| Field | Type | Description |
|-------|------|-------------|
| `step` | `number` | Step that just completed |
| `hasToolCalls` | `boolean` | Whether this step included tool calls |
| `text` | `string` | Text output from this step |

### `CompleteEvent`

| Field | Type | Description |
|-------|------|-------------|
| `result` | `string` | Final text result |
| `totalSteps` | `number` | Total steps taken |
| `usage` | `RunUsage` | Full usage summary |
| `aborted` | `boolean` | Whether the run was aborted |

### `HookDecision`

Returned by `onPreToolUse` and `onStepStart` to control execution flow.

| Field | Type | Description |
|-------|------|-------------|
| `decision` | `'allow' \| 'deny' \| 'ask' \| 'stop' \| 'continue'` | The decision |
| `reason` | `string?` | Optional reason for the decision |
| `modifiedArgs` | `unknown?` | Modified tool arguments (onPreToolUse only) |

---

## Permissions

### `evaluatePermission(toolName: string, args: unknown, config: PermissionConfig): Promise<boolean>`

Evaluate whether a tool call is permitted based on the permission configuration.

**Pipeline:**
1. If mode is `'accept-all'`, return `true` (unless per-tool override is `'never'`)
2. If mode is `'deny-all'`, return `false` (unless per-tool override is `'always'`)
3. Check per-tool overrides: `'always'` returns `true`, `'never'` returns `false`
4. If `'ask'` or no override: calls `onPermissionRequest`. The callback is **required** for mode `'ask'`: a
   config without it is rejected at construction by `validatePermissionConfig`, because falling open would
   silently allow every tool.

---

### `PermissionConfig`

| Field | Type | Description |
|-------|------|-------------|
| `mode` | `'accept-all' \| 'deny-all' \| 'ask'` | Global permission mode |
| `tools` | `Record<string, PermissionLevel>?` | Per-tool overrides |
| `onPermissionRequest` | `(request: { toolName: string; args: unknown }) => Promise<boolean>` | Callback for `'ask'` mode |

### `PermissionLevel`

`'always' | 'ask' | 'never'`

### `PermissionMode`

`'accept-all' | 'deny-all' | 'ask'`

### Provider-executed tools (no local `execute`)

Tools executed server-side by the provider (Anthropic `bash`/`textEditor`/`computer`, OpenAI
`applyPatch`, Google `codeExecution`, …) have no local `execute` function, and the AI SDK never routes
provider-executed calls through local code — so no per-call interception is possible. Their permission
gate is therefore applied at **registration** (in `buildTools`): a tool the policy cannot allow without
asking is omitted from the tool set entirely, so the provider is never offered it (a `console.warn`
names the omission).

- mode `'accept-all'`, or a per-tool `'always'` override → registered
- mode `'deny-all'`, a `'never'` override, or mode `'ask'` without an `'always'` override → not registered

For registered provider-executed tools the loop closes the observability gap: their calls are counted
into the `toolLimits` counters from the model stream, the run-level `maxToolCalls` cap is enforced
post-hoc (once the observed total exceeds the cap the run stops — the provider-side cost of the
current step is already spent), `onPostToolUse` fires for their results (with `providerExecuted: true`;
`durationMs` is `0`), and `tool-result` progress events carry `providerExecuted: true` plus a bounded
summary — the payload itself only appears behind `emitFullResult: true`, and provider-side errors
surface as bounded `tool-result` events (`PROVIDER ERROR`, text clipped at 200 chars).
`onPreToolUse` is deliberately **not** fired for them: its deny/stop decisions would be unenforceable
after server-side execution.

The per-iteration cap is enforced per call by the wrapper for local tools only — a local call is
never denied because provider calls happened in the same response (agent-do-7kf). The provider side
of `maxToolCallsPerIteration` is enforced post-hoc: a model response whose provider calls alone
exceed the cap stops the run after that step.

---

## Skills

### `createSkillTools(store: SkillStore): ToolSet`

Create Vercel AI SDK tools for skill management. Returns tools: `search_skills`, `install_skill`, `list_skills`, `remove_skill`.

---

### `buildSkillsPrompt(skills: Skill[]): string`

Build a system prompt section from a list of skills. Returns a formatted string to inject into the system prompt.

---

### `parseSkillMd(content: string, id?: string): Skill`

Parse a SKILL.md file with YAML frontmatter into a Skill object.

**Expected format:**
```
---
name: My Skill
description: Does things
author: Someone
version: 1.0.0
---

Skill content here...
```

---

### `InMemorySkillStore`

In-memory reference implementation of the `SkillStore` interface.

**Methods:**

| Method | Signature | Description |
|--------|-----------|-------------|
| `list` | `() => Promise<Skill[]>` | List all installed skills |
| `get` | `(skillId: string) => Promise<Skill \| undefined>` | Get a skill by ID |
| `install` | `(skill: Skill) => Promise<void>` | Install a skill |
| `remove` | `(skillId: string) => Promise<void>` | Remove a skill by ID |
| `search` | `(query: string) => Promise<Array<{ id, name, description, url? }>>` | Search skills by name, description, or content |

---

### `Skill`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique skill identifier |
| `name` | `string` | Human-readable name |
| `description` | `string` | What the skill does |
| `content` | `string` | The skill instructions/content |
| `author` | `string?` | Skill author |
| `version` | `string?` | Skill version |

### `SkillStore`

Interface for skill storage backends.

| Method | Signature |
|--------|-----------|
| `list` | `() => Promise<Skill[]>` |
| `get` | `(skillId: string) => Promise<Skill \| undefined>` |
| `install` | `(skill: Skill) => Promise<void>` |
| `remove` | `(skillId: string) => Promise<void>` |
| `search` | `(query: string) => Promise<Array<{ id, name, description, url? }>>` |

---

## Tools

Three consumer-facing tool factories. See [`docs/sandbox.md`](sandbox.md) for how each interacts with a sandbox.

### `createWorkspaceTools(workingDir: string, opts?: WorkspaceToolsOptions): ToolSet`

Project files rooted at `workingDir`, with a sensible deny-list (`.env`, `.ssh/**`, `.git/objects/**`, etc.) at the tool layer.

**Options:**
- `readOnly` — block all writes
- `onBeforeWrite(canonicalPath, op)` — gate per-write
- `exclude` — extra deny-list patterns
- `includeSensitive` — opt out of built-in sensitive-file defaults
- `sandbox?: SandboxApi` — when set, the internal store becomes `SandboxBackedMemoryStore` instead of `FilesystemMemoryStore`

**Returns tools:** `read_file`, `write_file`, `edit_file`, `list_directory`, `delete_file`, `grep_file`, `find_files`.

### `createMemoryTools(store: MemoryStore, agentId: string, opts?: MemoryToolsOptions): ToolSet`

The agent's private scratchpad, backed by any `MemoryStore`. Pass an `InMemoryMemoryStore`, `FilesystemMemoryStore`, or `SandboxBackedMemoryStore` depending on where you want the data to live.

**Returns tools:** `memory_read`, `memory_write`, `memory_list`, `memory_delete`, `memory_search`.

### `createShellTool(sandbox: SandboxApi, opts?: CreateShellToolOptions): ToolSet`

A single shell-exec tool wired to a `SandboxApi`. The sandbox is required: pass an isolating connector, or `createHostSandbox()` explicitly to run on the host (**not** isolation). Calling it with no sandbox throws rather than silently using the host. Model-visible stdout/stderr is framed in `<tool_output>` markers and passed through the same injection-marker redaction as the file and memory tools. The host sandbox forwards an allowlisted environment rather than the parent's (`inheritEnv: true` opts out) — see [sandbox.md](sandbox.md#environment-policy-host-connector).

**Options:**
- `name` — override the model-facing tool name (default `bash`)
- `cwd`, `defaultTimeoutMs`, `maxTimeoutMs`, `maxOutputBytes`

**Returns one tool** named after `opts.name` (default `bash`).

### Custom tool return values are content-guarded

Every tool the loop executes is normalised into a `ToolResult`. A tool that returns anything other than a
`ToolResult` — the common case for a caller-registered tool, e.g. a web scraper returning page text — has its
value put through the same guards the built-in tools apply before it reaches the model: framed in
`<tool_output tool="…" source="tool-return">` boundary tags, `ignore previous instructions`-style markers
replaced with `[redacted prompt-injection marker]`, forged `</tool_output>` tags escaped so content cannot close
its own frame, and capped at 256 KB. `userSummary` keeps the tool's raw text so operator logs stay diagnostic,
and `data` carries `{ guarded: true, truncated, totalBytes, redactedMarkerCount, neutralisedDelimiterCount }`.

A tool that has already sanitised its own output returns a `ToolResult` and is passed through untouched — that is
the escape hatch. To apply the same guards inside your own tool, use the exported helpers:

### `wrapForModel(body: string, opts: WrapOptions): WrappedContent`

Frame `body` in `<tool_output>` boundary tags, redact injection markers, escape forged boundary tags and cap it.
`opts` is `{ tool, path? | command? | source?, maxBytes? }`; at least one origin is required so a marker always
names where the content came from. Returns `{ content, truncated, includedBytes, totalBytes, redactedMarkerCount,
neutralisedDelimiterCount }` — `content` is what goes in `modelContent`, the rest in `data`.

### `sanitiseUntrustedText(body: string): SanitisedUntrustedText`

The same two transforms without the frame, for a payload you cannot wrap without breaking its schema (a
provider-shaped or structured result). Returns `{ text, redactedMarkerCount, neutralisedDelimiterCount }`.

---

## Usage Tracking

### `UsageTracker`

Tracks token usage and cost across steps within a single agent run.

**Constructor:**

```typescript
new UsageTracker(options?: {
  pricing?: PricingTable;
  perRunLimit?: number;
  perDayLimit?: number;
  onLimitExceeded?: (event: { type: string; spent: number; limit: number }) => Promise<boolean>;
})
```

**Methods:**

| Method | Signature | Description |
|--------|-----------|-------------|
| `record` | `(step: number, model: string, inputTokens: number, outputTokens: number) => UsageRecord` | Record usage for a step |
| `getSummary` | `() => RunUsage` | Get the current usage summary |
| `checkLimits` | `() => Promise<boolean>` | Check spending limits. Returns `true` if OK to continue. |

---

### `estimateCost(model: string, inputTokens: number, outputTokens: number, pricing?: PricingTable): number`

Estimate cost in USD for a given model and token counts. Uses `DEFAULT_PRICING` if no custom pricing table is provided. Automatically normalizes OpenRouter-style model IDs (strips provider prefix).

---

### `DEFAULT_PRICING`

Built-in pricing table with prices per 1M tokens in USD. Covers Anthropic, OpenAI, Google Gemini, Mistral, Groq, Perplexity, and local models.

**Type:** `PricingTable` (which is `Record<string, { input: number; output: number }>`)

---

## Testing

Exported from `agent-do/testing`.

### `createMockModel(options: MockModelOptions): MockLanguageModelV3`

Create a mock `LanguageModel` that returns predetermined responses. Works with both `streamText()` and `generateText()` from the Vercel AI SDK.

**Parameters:**

### `MockModelOptions`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `responses` | `MockResponse[]` | required | Predetermined responses. `responses[0]` for call 1, etc. |
| `modelId` | `string` | `'mock-model'` | Model ID for logging |
| `provider` | `string` | `'mock-provider'` | Provider name for logging |
| `inputTokensPerCall` | `number` | `10` | Simulated input tokens per call |
| `outputTokensPerCall` | `number` | `20` | Simulated output tokens per call |

### `MockResponse`

| Field | Type | Description |
|-------|------|-------------|
| `text` | `string?` | Text response |
| `toolCalls` | `Array<{ toolName: string; args: Record<string, unknown> }>?` | Tool calls to simulate |
