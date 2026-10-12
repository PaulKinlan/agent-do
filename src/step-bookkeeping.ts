/**
 * Step bookkeeping: the `onStepEnd` hook that makes per-inner-step usage the
 * authoritative ledger entry and enforces the hard spending cap.
 *
 * Split out of `src/loop.ts` (agent-do-4os). Re-exported from the loop module so
 * existing importers (including tests/cost-runaway.test.ts) are unaffected.
 */

import type { AgentConfig, DebugEvent } from './types.js';
import { emitCacheDebug } from './debug.js';
import { UsageTracker } from './usage.js';

/**
 * Build an `onStepEnd` hook that records usage per inner step and
 * aborts the stream when the hard spending cap would be crossed (#31,
 * plus PR #65 review follow-ups).
 *
 * ### Before
 *
 * `tracker.checkLimits()` only ran *between* outer iterations, and
 * `tracker.record()` was called once per outer iteration with the
 * total usage from the SDK result’s aggregate usage. That meant:
 *
 * - The hard-cap projection inside the hook only saw the tracker's
 *   **cross-iteration** total, so N small inner steps in the same
 *   iteration could cumulatively exceed the hard cap without any
 *   individual step tripping the check (Codex #65 P1).
 * - When the hard cap did abort, the loop broke before
 *   that aggregate was awaited, so the step(s) that caused the
 *   abort never made it into the tracker — `RunResult.usage`
 *   undercounted the actual spend (Codex #65 P2 / Copilot).
 *
 * ### After
 *
 * The hook is now the **authoritative per-step recorder**. Each inner
 * model step calls `tracker.record()` with its own usage, so the
 * tracker's running total reflects every step the SDK has completed —
 * including intra-iteration accumulation — and the hard-cap projection
 * uses that running total directly.
 *
 * Because the hook records before it decides whether to abort, an
 * aborted iteration's last step is already in the ledger by the time
 * the outer loop breaks. The outer loop no longer calls
 * `tracker.record(...)` itself — that would double-count when the
 * hook is active. It still awaits `result.usage` at the end of
 * a clean iteration (so the recorded per-step totals reconcile with
 * the SDK's view) but only to surface mismatches, not to ledger.
 *
 * Returns `undefined` when the caller disables usage tracking entirely
 * (so hook dispatch is free when callers opt out).
 */
export function buildOnStepEnd(
  config: AgentConfig,
  tracker: UsageTracker,
  abortController: AbortController,
  outerStep: number,
  emitDebug?: (event: DebugEvent) => void,
): ((step: unknown) => void) | undefined {
  // Debug-only configs still need onStepEnd so cache events fire.
  const wantCache = config.debug && (config.debug.all || config.debug.cache);
  if (config.usage?.enabled === false && !wantCache) return undefined;
  const softLimit = config.usage?.limits?.perRun;
  const multiplier = config.usage?.hardLimitMultiplier ?? 1.25;
  const hardLimit = softLimit !== undefined ? softLimit * multiplier : undefined;
  const modelId =
    typeof config.model === 'string'
      ? config.model
      : config.model.modelId;

  return (step: unknown) => {
    // Cache debug event — fire regardless of usage.enabled because
    // operators debugging cache effectiveness still want the numbers.
    if (wantCache && emitDebug) {
      emitCacheDebug(config.debug, emitDebug, outerStep, step);
    }

    if (config.usage?.enabled === false) return;
    const usage = (step as { usage?: { inputTokens?: number; outputTokens?: number } })
      .usage;
    if (!usage) return;
    // Record first so the tracker's running total includes this step
    // — the hard-cap projection then sees an authoritative sum across
    // all inner steps that have already finished, not just the
    // cross-iteration baseline.
    tracker.record(
      outerStep,
      modelId,
      usage.inputTokens ?? 0,
      usage.outputTokens ?? 0,
    );
    if (hardLimit === undefined || softLimit === undefined) return;
    const spent = tracker.getSummary().totalCost;
    if (spent >= hardLimit && !abortController.signal.aborted) {
      abortController.abort(
        new Error(
          `Hard spending cap reached: $${spent.toFixed(4)} ≥ $${hardLimit.toFixed(4)} (soft $${softLimit.toFixed(4)} × ${multiplier})`,
        ),
      );
    }
  };
}
