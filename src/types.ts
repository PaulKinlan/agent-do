import type { LanguageModel, ToolSet } from 'ai';

// Progress events emitted during agent execution
export interface ProgressEvent {
  type:
    | 'thinking'
    | 'tool-call'
    | 'tool-result'
    | 'text'
    | 'step-complete'
    | 'done'
    | 'error';
  content: string;
  toolName?: string;
  toolArgs?: unknown;
  /**
   * Full raw tool result. Only populated on `tool-result` events when the
   * agent was created with `emitFullResult: true`. See issue #48.
   *
   * Default behaviour emits only `summary` + `data` so secrets / large
   * file contents don't leak through logs and telemetry.
   */
  toolResult?: unknown;
  /**
   * Short human-readable summary of a `tool-result` event. Includes paths,
   * sizes, error codes — safe for operator logs; not intended for the model.
   */
  summary?: string;
  /**
   * Structured metadata about the tool invocation (tool-specific keys like
   * `path`, `bytes`, `matchCount`). Stable enough for programmatic consumers.
   */
  data?: Record<string, unknown>;
  /** True when a `tool-result` represents a blocked / denied operation. */
  blocked?: boolean;
  step?: number;
  totalSteps?: number;
}

// Skill definition
export interface Skill {
  id: string;
  name: string;
  description: string;
  content: string; // The actual skill instructions
  author?: string;
  version?: string;
}

/**
 * A search result returned by `SkillStore.search()`.
 *
 * Deliberately does **not** include a `url` field. Earlier drafts of the
 * interface carried `url?: string` and signalled "external skill registries
 * are fine to wire up." That's an SSRF / supply-chain footgun (see #34): a
 * hostile registry could return a URL the agent then auto-fetches with the
 * user's credentials. If you need URL-backed skill registries, build them
 * outside this interface, gate behind an explicit host allowlist, require
 * HTTPS, and never auto-install — `install()` must always receive the
 * verified content directly.
 */
export interface SkillSearchResult {
  id: string;
  name: string;
  description: string;
}

/**
 * Storage interface for skill definitions.
 *
 * Implementations are expected to be local (in-memory, OPFS, IndexedDB,
 * SQLite, …). External / network-backed implementations must not auto-fetch
 * skill content from `search()` results — see {@link SkillSearchResult}.
 */
export interface SkillStore {
  list(): Promise<Skill[]>;
  get(skillId: string): Promise<Skill | undefined>;
  install(skill: Skill): Promise<void>;
  remove(skillId: string): Promise<void>;
  search(query: string): Promise<SkillSearchResult[]>;
}

// Usage record
export interface UsageRecord {
  timestamp: string;
  step: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  model: string;
}

// Usage summary for a run
export interface RunUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  steps: number;
  records: UsageRecord[];
}

// Permission levels
export type PermissionLevel = 'always' | 'ask' | 'never';
export type PermissionMode = 'accept-all' | 'deny-all' | 'ask';

export interface PermissionConfig {
  mode: PermissionMode;
  tools?: Record<string, PermissionLevel>; // per-tool overrides
  onPermissionRequest?: (request: {
    toolName: string;
    args: unknown;
  }) => Promise<boolean>;
}

// Hook events
export interface PreToolUseEvent {
  toolName: string;
  args: unknown;
  step: number;
}

export interface PostToolUseEvent {
  toolName: string;
  args: unknown;
  result: unknown;
  step: number;
  durationMs: number;
}

export interface StepStartEvent {
  step: number;
  totalSteps: number;
  tokensSoFar: number;
  costSoFar: number;
}

export interface StepCompleteEvent {
  step: number;
  hasToolCalls: boolean;
  text: string;
}

export interface CompleteEvent {
  result: string;
  totalSteps: number;
  usage: RunUsage;
  aborted: boolean;
}

// Hook decision
export interface HookDecision {
  decision: 'allow' | 'deny' | 'ask' | 'stop' | 'continue';
  reason?: string;
  modifiedArgs?: unknown; // for PreToolUse: modify the tool's input
}

// Hooks configuration
export interface AgentHooks {
  onPreToolUse?: (event: PreToolUseEvent) => Promise<HookDecision | void>;
  onPostToolUse?: (event: PostToolUseEvent) => Promise<void>;
  onStepStart?: (event: StepStartEvent) => Promise<HookDecision | void>;
  onStepComplete?: (event: StepCompleteEvent) => Promise<void>;
  onComplete?: (event: CompleteEvent) => Promise<void>;
  onUsage?: (record: UsageRecord) => Promise<void>;
}

// Pricing table
export type PricingTable = Record<string, { input: number; output: number }>;

// Agent configuration
export interface AgentConfig {
  id: string;
  name: string;
  model: LanguageModel;
  systemPrompt?: string; // Raw system prompt (CLAUDE.md content)
  tools?: ToolSet;
  skills?: SkillStore;
  maxIterations?: number;
  innerStepLimit?: number;
  hooks?: AgentHooks;
  permissions?: PermissionConfig;
  usage?: {
    enabled?: boolean;
    pricing?: PricingTable;
    limits?: {
      perRun?: number;
      perDay?: number;
    };
    onLimitExceeded?: (event: {
      type: string;
      spent: number;
      limit: number;
    }) => Promise<boolean>;
  };
  signal?: AbortSignal;
  /**
   * Include full raw tool results on `tool-result` progress events.
   *
   * Default (`false`): events carry only `summary` + structured `data`.
   * File contents, command output, and anything else the tool returned
   * stay out of the event stream. This keeps secrets out of CI logs and
   * telemetry by default.
   *
   * Set `true` when you need full fidelity for debugging or when you're
   * piping events to a trusted consumer that needs the raw payload.
   */
  emitFullResult?: boolean;
  /**
   * Number of recent outer iterations whose tool-output bodies are kept
   * verbatim in the conversation history. Older iterations get their
   * `<tool_output>...</tool_output>` bodies replaced with self-closing
   * markers, so injected content from a poisoned tool result can't
   * keep influencing the model on every subsequent step.
   *
   * Default `1` — only the most recent iteration's tool outputs flow in
   * full to the next call. The model still sees that the tool was
   * invoked (via the marker attributes) and the assistant's reasoning
   * about it, but the raw body is gone. See issue #33.
   *
   * Set to `Infinity` to keep the historical "everything stays in
   * context forever" behaviour.
   */
  historyKeepWindow?: number;
}

// A message in conversation history
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Filesystem store options
export interface FilesystemMemoryStoreOptions {
  /** Block all write operations. Agent can only read existing files. */
  readOnly?: boolean;
  /**
   * Called before any write/append/delete/mkdir operation.
   * Receives the canonicalized relative path (safe against ../ bypass).
   * Return true to allow, false to block.
   * Supports both sync and async callbacks.
   */
  onBeforeWrite?: (agentId: string, filePath: string, operation: 'write' | 'append' | 'delete' | 'mkdir') => boolean | Promise<boolean>;
}

// Agent instance
export interface Agent {
  readonly id: string;
  readonly name: string;
  run(task: string, context?: string, history?: ConversationMessage[]): Promise<string>;
  stream(task: string, context?: string, history?: ConversationMessage[]): AsyncIterable<ProgressEvent>;
  abort(): void;
}

// Run result
export interface RunResult {
  text: string;
  usage: RunUsage;
  steps: number;
  aborted: boolean;
}
