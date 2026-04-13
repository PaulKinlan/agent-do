/**
 * Eval framework types.
 *
 * Defines the shapes for eval suites, cases, assertions, and results.
 */

import type { LanguageModel, ToolSet } from 'ai';
import type { AgentHooks, ConversationMessage, PermissionConfig, PricingTable } from '../types.js';
import type { MemoryStore } from '../stores.js';

// ── Assertions ──

export interface ContainsAssertion {
  type: 'contains';
  value: string;
}

export interface NotContainsAssertion {
  type: 'not-contains';
  value: string;
}

export interface RegexAssertion {
  type: 'regex';
  pattern: string;
  flags?: string;
}

export interface JsonSchemaAssertion {
  type: 'json-schema';
  schema: Record<string, unknown>;
}

export interface ToolCalledAssertion {
  type: 'tool-called';
  tool: string;
}

export interface ToolNotCalledAssertion {
  type: 'tool-not-called';
  tool: string;
}

export interface ToolArgsAssertion {
  type: 'tool-args';
  tool: string;
  /** Partial match — every key/value in args must appear in the actual tool call args. */
  args: Record<string, unknown>;
}

export interface FileExistsAssertion {
  type: 'file-exists';
  path: string;
}

export interface FileContainsAssertion {
  type: 'file-contains';
  path: string;
  value: string;
}

export interface MaxStepsAssertion {
  type: 'max-steps';
  max: number;
}

export interface MaxCostAssertion {
  type: 'max-cost';
  /** Maximum cost in USD. */
  maxUsd: number;
}

export interface LlmRubricAssertion {
  type: 'llm-rubric';
  rubric: string;
  /** 'pass-fail' returns boolean. '1-5' returns a numeric score (pass if >= 3). */
  score?: 'pass-fail' | '1-5';
  /** Model to use as judge. If not provided, uses the eval's model. */
  judgeModel?: LanguageModel;
}

export interface CustomAssertion {
  type: 'custom';
  /** Name for display purposes. */
  name: string;
  /** Function that receives the case result and returns pass/fail. */
  fn: (result: CaseRunResult) => boolean | Promise<boolean>;
}

export type Assertion =
  | ContainsAssertion
  | NotContainsAssertion
  | RegexAssertion
  | JsonSchemaAssertion
  | ToolCalledAssertion
  | ToolNotCalledAssertion
  | ToolArgsAssertion
  | FileExistsAssertion
  | FileContainsAssertion
  | MaxStepsAssertion
  | MaxCostAssertion
  | LlmRubricAssertion
  | CustomAssertion;

// ── Eval Case ──

export interface EvalCase {
  /** Human-readable name for the test case. */
  name: string;
  /** The task/prompt to send to the agent. */
  input: string;
  /** Optional context passed as the second arg to agent.run(). */
  context?: string;
  /** Optional conversation history. */
  history?: ConversationMessage[];
  /** Assertions to check against the result. */
  assert: Assertion[];
  /** How many times to run this case (for non-determinism). Defaults to 1. */
  runs?: number;
  /** Timeout in ms for this case. Defaults to 60000. */
  timeout?: number;
}

// ── Eval Suite ──

export interface EvalSuiteConfig {
  /** Name of the eval suite. */
  name: string;
  /** Description. */
  description?: string;
  /** The model to use. Can be overridden per-case or via runEvals options. */
  model?: LanguageModel;
  /** System prompt for the agent. */
  systemPrompt?: string;
  /** Tools for the agent. If not provided, file tools backed by an in-memory store are created. */
  tools?: ToolSet;
  /** Max iterations for the agent loop. Defaults to 20. */
  maxIterations?: number;
  /** Hooks. */
  hooks?: AgentHooks;
  /** Permission config. */
  permissions?: PermissionConfig;
  /** Pricing table for cost tracking. */
  pricing?: PricingTable;
  /** The eval cases. */
  cases: EvalCase[];
}

// ── Run Options ──

export interface RunEvalsOptions {
  /** Override the model for all cases. */
  model?: LanguageModel;
  /** Run across multiple providers for comparison. */
  providers?: Array<{
    name: string;
    model: LanguageModel;
  }>;
  /** Output format. Defaults to 'console'. */
  output?: 'console' | 'json' | 'csv' | 'silent';
  /** Custom memory store factory. Called once per case. Defaults to InMemoryMemoryStore. */
  createStore?: () => MemoryStore;
  /** Abort signal. */
  signal?: AbortSignal;
  /** Concurrency — how many cases to run in parallel. Defaults to 1 (sequential). */
  concurrency?: number;
}

// ── Results ──

/** Intermediate result from running a single case (before assertions). */
export interface CaseRunResult {
  /** The agent's text response. */
  text: string;
  /** Total steps taken. */
  steps: number;
  /** Total cost in USD. */
  cost: number;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Tool calls made during execution. */
  toolCalls: Array<{
    toolName: string;
    args: Record<string, unknown>;
    result: unknown;
  }>;
  /** The memory store state after execution. */
  store: MemoryStore;
  /** Agent ID used. */
  agentId: string;
  /** Whether the run was aborted. */
  aborted: boolean;
}

/** Result of a single assertion. */
export interface AssertionResult {
  assertion: Assertion;
  passed: boolean;
  message: string;
}

/** Result of a single eval case. */
export interface CaseResult {
  name: string;
  input: string;
  passed: boolean;
  assertions: AssertionResult[];
  cost: number;
  durationMs: number;
  steps: number;
  text: string;
  error?: string;
  /** For multi-run cases, individual run results. */
  runs?: CaseResult[];
}

/** Result of a full eval suite for one provider. */
export interface ProviderResult {
  provider: string;
  model: string;
  totalCases: number;
  passed: number;
  failed: number;
  totalCost: number;
  durationMs: number;
  cases: CaseResult[];
}

/** Full eval result (may contain multiple providers for comparison). */
export interface EvalResult {
  name: string;
  timestamp: string;
  providers: ProviderResult[];
}
