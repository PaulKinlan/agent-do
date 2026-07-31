import type { PricingTable, RunUsage, UsageRecord } from './types.js';

// Built-in pricing table — prices per 1M tokens in USD.
//
// Keys are matched exactly first, then by longest prefix (see
// `longestPrefixMatch`), so a dated or suffixed variant of a listed model
// resolves to the most specific entry. Models absent from the table cost
// `0` and disable spending limits — add an entry (or pass a custom
// `AgentConfig.usage.pricing`) rather than relying on the fallback.
export const DEFAULT_PRICING: PricingTable = {
  // Anthropic — newest first.
  'claude-fable-5': { input: 10.0, output: 50.0 },
  // Same capabilities and rates as Fable 5; available via Project Glasswing.
  'claude-mythos-5': { input: 10.0, output: 50.0 },
  'claude-opus-5': { input: 5.0, output: 25.0 },
  'claude-opus-4-8': { input: 5.0, output: 25.0 },
  // List price. An introductory $2/$10 rate applies through 2026-08-31;
  // we bill at list so cost estimates never under-report after it lapses.
  'claude-sonnet-5': { input: 3.0, output: 15.0 },
  'claude-opus-4-7': { input: 5.0, output: 25.0 },
  'claude-opus-4-6': { input: 5.0, output: 25.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  'claude-opus-4-5': { input: 5.0, output: 25.0 },
  'claude-sonnet-4-5': { input: 3.0, output: 15.0 },
  'claude-opus-4-1': { input: 15.0, output: 75.0 },
  'claude-opus-4-0': { input: 15.0, output: 75.0 },
  'claude-sonnet-4-0': { input: 3.0, output: 15.0 },
  'claude-3-5-sonnet': { input: 3.0, output: 15.0 },
  'claude-3-5-haiku': { input: 0.8, output: 4.0 },
  'claude-3-opus': { input: 15.0, output: 75.0 },
  'claude-3-sonnet': { input: 3.0, output: 15.0 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },

  // OpenAI — https://developers.openai.com/api/docs/models
  // GPT-5.6 ships as three named tiers. The bare `gpt-5.6` alias routes to
  // Sol, so it carries Sol's rates.
  'gpt-5.6-sol': { input: 5.0, output: 30.0 },
  'gpt-5.6-terra': { input: 2.0, output: 12.0 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2 },
  'gpt-5.6': { input: 5.0, output: 30.0 },
  'gpt-5': { input: 1.25, output: 10.0 },
  'gpt-5.4': { input: 2.5, output: 15.0 },
  'gpt-5.3': { input: 2.5, output: 15.0 },
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10.0, output: 30.0 },
  o1: { input: 15.0, output: 60.0 },
  o3: { input: 2.0, output: 8.0 },
  'o3-mini': { input: 1.1, output: 4.4 },
  'o4-mini': { input: 1.1, output: 4.4 },

  // Google Gemini — https://ai.google.dev/gemini-api/docs/pricing
  'gemini-3.6-flash': { input: 1.5, output: 7.5 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  'gemini-3.5-flash': { input: 1.5, output: 9.0 },
  // Gemini charges more for prompts over 200k tokens (3.1 Pro: $4/$18).
  // This table has no long-context tier, so it carries the <=200k rate and
  // will under-report on very large prompts.
  'gemini-3.1-pro': { input: 2.0, output: 12.0 },
  'gemini-3-flash': { input: 0.5, output: 3.0 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  'gemini-2.5-pro': { input: 1.25, output: 10.0 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-2.0-flash-lite': { input: 0.075, output: 0.3 },
  'gemini-1.5-pro': { input: 1.25, output: 5.0 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },

  // Mistral
  'mistral-large-3': { input: 0.5, output: 1.5 },
  'mistral-large': { input: 0.5, output: 1.5 },
  'mistral-medium-3': { input: 0.4, output: 2.0 },
  'mistral-medium': { input: 0.4, output: 2.0 },
  'mistral-small-3': { input: 0.075, output: 0.2 },
  'mistral-small': { input: 0.03, output: 0.11 },
  codestral: { input: 0.3, output: 0.9 },
  'ministral-8b': { input: 0.15, output: 0.15 },
  'ministral-3b': { input: 0.1, output: 0.1 },

  // Groq
  'llama-4-scout': { input: 0.11, output: 0.34 },
  'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
  'llama-3.1-70b-versatile': { input: 0.59, output: 0.79 },
  'llama-3.1-8b-instant': { input: 0.05, output: 0.08 },
  'qwen3-32b': { input: 0.29, output: 0.59 },
  'mixtral-8x7b-32768': { input: 0.24, output: 0.24 },

  // Z.ai (Zhipu AI / GLM) — https://docs.z.ai/guides/overview/pricing
  // The `zai` CLI provider shipped without these, so every zai run had
  // cost tracking and spending limits silently disabled.
  'glm-5.2': { input: 1.4, output: 4.4 },
  'glm-5.1': { input: 1.4, output: 4.4 },
  'glm-5-turbo': { input: 1.2, output: 4.0 },
  'glm-5': { input: 1.0, output: 3.2 },
  'glm-4.7-flashx': { input: 0.07, output: 0.4 },
  'glm-4.7-flash': { input: 0, output: 0 },
  'glm-4.7': { input: 0.6, output: 2.2 },
  'glm-4.6': { input: 0.6, output: 2.2 },
  'glm-4.5-airx': { input: 1.1, output: 4.5 },
  'glm-4.5-air': { input: 0.2, output: 1.1 },
  'glm-4.5-flash': { input: 0, output: 0 },
  'glm-4.5-x': { input: 2.2, output: 8.9 },
  'glm-4.5': { input: 0.6, output: 2.2 },

  // Perplexity
  sonar: { input: 1.0, output: 1.0 },
  'sonar-pro': { input: 3.0, output: 15.0 },
  'sonar-reasoning': { input: 2.0, output: 8.0 },
  'sonar-deep-research': { input: 2.0, output: 8.0 },

  // Local (free)
  'llama3.2': { input: 0, output: 0 },
  llama3: { input: 0, output: 0 },
  'mistral-local': { input: 0, output: 0 },
  codellama: { input: 0, output: 0 },
  'deepseek-coder': { input: 0, output: 0 },
  phi3: { input: 0, output: 0 },
  gemma2: { input: 0, output: 0 },
  'qwen2.5': { input: 0, output: 0 },
};

/**
 * Normalize model ID — strip provider prefix for OpenRouter-style IDs.
 */
function normalizeModelId(model: string): string {
  if (model.includes('/')) {
    return model.split('/').pop()!;
  }
  return model;
}

/**
 * Resolve a model ID to pricing by longest matching prefix.
 *
 * Providers publish dated and suffixed variants of models whose *base*
 * name is also a pricing key — `gpt-4.1-mini-2025-04-14` starts with both
 * `gpt-4.1` and `gpt-4.1-mini`; `gemini-2.5-flash-lite-preview-09-2025`
 * starts with both `gemini-2.5-flash` and `gemini-2.5-flash-lite`. Taking
 * the first prefix in table-insertion order billed those at the parent
 * model's (much higher) rate, which silently mis-fires the `perRunLimit`
 * and `perDayLimit` spending guards. Picking the longest match resolves to
 * the most specific entry regardless of key order.
 *
 * Ties are impossible: two keys of equal length that are both prefixes of
 * the same string are the same key.
 */
function longestPrefixMatch(
  table: PricingTable,
  modelId: string,
): PricingTable[string] | undefined {
  let bestKey: string | undefined;
  for (const key of Object.keys(table)) {
    if (!modelId.startsWith(key)) continue;
    if (bestKey === undefined || key.length > bestKey.length) bestKey = key;
  }
  return bestKey === undefined ? undefined : table[bestKey];
}

/**
 * Models we've already warned about — keyed by `${tableId}:${modelId}` so a
 * caller passing a custom `pricing` table doesn't suppress warnings about
 * the default table (and vice versa). Bounded by the number of distinct
 * model IDs an agent uses, so it can't grow without bound in practice.
 *
 * The store is module-scoped on purpose: warning once per process matches
 * the lifetime of `agent-do` runs in CLIs and short-lived servers.
 * Long-lived servers can call {@link resetPricingWarnings} between runs
 * if they want a fresh warning cycle.
 */
const WARNED_MODELS = new Set<string>();

/** Reset the warned-model set. Mainly for tests / long-lived servers. */
export function resetPricingWarnings(): void {
  WARNED_MODELS.clear();
}

/**
 * Estimate cost in USD for a given model and token counts.
 *
 * When the model isn't in the active pricing table, returns `0` (preserving
 * the historical contract — cost tracking is best-effort) but emits a
 * one-time stderr warning per process so cost-limit enforcement based on
 * an unknown model isn't silently disabled. Pass your own
 * {@link PricingTable} via `AgentConfig.usage.pricing` to override.
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  pricing?: PricingTable,
): number {
  const table = pricing ?? DEFAULT_PRICING;
  const normalized = normalizeModelId(model);

  const prices = table[normalized] ?? longestPrefixMatch(table, normalized);

  if (!prices) {
    // Distinguish the built-in default table from a truly caller-supplied
    // custom one when de-duplicating warnings. Passing DEFAULT_PRICING
    // explicitly (UsageTracker does this internally) should still count as
    // the default — otherwise the same model would warn twice and appear
    // in the warning text as "custom".
    const tableId =
      pricing === undefined || pricing === DEFAULT_PRICING ? 'default' : 'custom';
    const key = `${tableId}:${normalized}`;
    if (!WARNED_MODELS.has(key)) {
      WARNED_MODELS.add(key);
      const writeStderr = (msg: string): void => {
        // Browsers don't have process.stderr; fall back to console.warn.
        const proc = (globalThis as { process?: { stderr?: { write?: (s: string) => void } } }).process;
        if (proc?.stderr?.write) proc.stderr.write(msg);
        else console.warn(msg.trimEnd());
      };
      writeStderr(
        `[agent-do] No pricing entry for model "${normalized}" in the ${tableId} table; ` +
        `cost tracking and spending limits are disabled for this model. ` +
        `Set AgentConfig.usage.pricing to provide your own rates.\n`,
      );
    }
    return 0;
  }

  return (
    (inputTokens / 1_000_000) * prices.input +
    (outputTokens / 1_000_000) * prices.output
  );
}

/**
 * Tracks usage across steps within a single agent run.
 */
export class UsageTracker {
  private records: UsageRecord[] = [];
  private pricing: PricingTable;
  private perRunLimit?: number;
  private perDayLimit?: number;
  private onLimitExceeded?: (event: {
    type: string;
    spent: number;
    limit: number;
  }) => Promise<boolean>;

  constructor(options?: {
    pricing?: PricingTable;
    perRunLimit?: number;
    perDayLimit?: number;
    onLimitExceeded?: (event: {
      type: string;
      spent: number;
      limit: number;
    }) => Promise<boolean>;
  }) {
    this.pricing = options?.pricing ?? DEFAULT_PRICING;
    this.perRunLimit = options?.perRunLimit;
    this.perDayLimit = options?.perDayLimit;
    this.onLimitExceeded = options?.onLimitExceeded;
  }

  /**
   * Record usage for a step.
   */
  record(
    step: number,
    model: string,
    inputTokens: number,
    outputTokens: number,
  ): UsageRecord {
    const cost = estimateCost(model, inputTokens, outputTokens, this.pricing);
    const record: UsageRecord = {
      timestamp: new Date().toISOString(),
      step,
      inputTokens,
      outputTokens,
      estimatedCost: cost,
      model,
    };
    this.records.push(record);
    return record;
  }

  /**
   * Get the current usage summary.
   */
  getSummary(): RunUsage {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;

    for (const r of this.records) {
      totalInputTokens += r.inputTokens;
      totalOutputTokens += r.outputTokens;
      totalCost += r.estimatedCost;
    }

    return {
      totalInputTokens,
      totalOutputTokens,
      totalCost,
      steps: this.records.length,
      records: [...this.records],
    };
  }

  /**
   * Check whether spending limits have been exceeded.
   * Returns true if OK to continue, false if limit exceeded and not overridden.
   */
  async checkLimits(): Promise<boolean> {
    const summary = this.getSummary();

    // Check per-run limit
    if (this.perRunLimit !== undefined && summary.totalCost >= this.perRunLimit) {
      if (this.onLimitExceeded) {
        return this.onLimitExceeded({
          type: 'perRun',
          spent: summary.totalCost,
          limit: this.perRunLimit,
        });
      }
      return false;
    }

    // Check per-day limit (note: in a standalone library we only have
    // the current run's data. The consumer should track across runs.)
    if (this.perDayLimit !== undefined && summary.totalCost >= this.perDayLimit) {
      if (this.onLimitExceeded) {
        return this.onLimitExceeded({
          type: 'perDay',
          spent: summary.totalCost,
          limit: this.perDayLimit,
        });
      }
      return false;
    }

    return true;
  }
}
