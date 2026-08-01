import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  UsageTracker,
  estimateCost,
  DEFAULT_PRICING,
  resetPricingWarnings,
} from '../src/usage.js';
import { DEFAULT_MODELS } from '../src/cli/resolve-model.js';

describe('estimateCost', () => {
  beforeEach(() => {
    resetPricingWarnings();
  });

  it('calculates cost for known model', () => {
    // claude-sonnet-4-6: input 3.0/1M, output 15.0/1M
    const cost = estimateCost('claude-sonnet-4-6', 1000, 500);
    // (1000/1M)*3.0 + (500/1M)*15.0 = 0.003 + 0.0075 = 0.0105
    expect(cost).toBeCloseTo(0.0105, 6);
  });

  it('returns 0 for unknown model', () => {
    // Suppress the new warning so this assertion stays focused on the
    // 0-cost contract; the warning behaviour is tested separately below.
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(estimateCost('unknown-model', 1000, 500)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('uses custom pricing table', () => {
    const pricing = { 'my-model': { input: 10.0, output: 20.0 } };
    const cost = estimateCost('my-model', 1_000_000, 1_000_000, pricing);
    expect(cost).toBe(30.0);
  });

  it('handles OpenRouter-style model IDs', () => {
    const cost = estimateCost('anthropic/claude-sonnet-4-6', 1000, 500);
    expect(cost).toBeCloseTo(0.0105, 6);
  });

  it('handles prefix matching', () => {
    // "claude-sonnet-4-6-20260301" should match "claude-sonnet-4-6"
    const cost = estimateCost('claude-sonnet-4-6-20260301', 1000, 500);
    expect(cost).toBeCloseTo(0.0105, 6);
  });

  describe('prefix matching picks the most specific entry', () => {
    // Providers ship dated/suffixed variants of models whose *base* name is
    // also a pricing key ("gpt-4.1-mini-2025-04-14" vs "gpt-4.1"). Matching
    // the first prefix in table order billed those at the parent model's
    // rate — up to 5x the real price — which silently mis-fires
    // `usage.perRunLimit` / `perDayLimit`. The longest matching key wins.
    const M = 1_000_000;

    it('prices a dated gpt-4.1-mini as gpt-4.1-mini, not gpt-4.1', () => {
      // gpt-4.1-mini: 0.4 in / 1.6 out. gpt-4.1: 2.0 / 8.0.
      expect(estimateCost('gpt-4.1-mini-2025-04-14', M, M)).toBeCloseTo(2.0, 6);
    });

    it('prices a dated gpt-4.1-nano as gpt-4.1-nano, not gpt-4.1', () => {
      // gpt-4.1-nano: 0.1 in / 0.4 out.
      expect(estimateCost('gpt-4.1-nano-2025-04-14', M, M)).toBeCloseTo(0.5, 6);
    });

    it('prices a gemini flash-lite preview as flash-lite, not flash', () => {
      // gemini-2.5-flash-lite: 0.1 / 0.4. gemini-2.5-flash: 0.3 / 2.5.
      expect(
        estimateCost('gemini-2.5-flash-lite-preview-09-2025', M, M),
      ).toBeCloseTo(0.5, 6);
    });

    it('prices a dated o3-mini as o3-mini, not o3', () => {
      // o3-mini: 1.1 / 4.4. o3: 2.0 / 8.0.
      expect(estimateCost('o3-mini-2025-01-31', M, M)).toBeCloseTo(5.5, 6);
    });

    it('prices glm-4.5-air as air, not as the full glm-4.5', () => {
      // glm-4.5-air: 0.2 / 1.1. glm-4.5: 0.6 / 2.2.
      expect(estimateCost('glm-4.5-air-0722', M, M)).toBeCloseTo(1.3, 6);
    });

    it('still prefers an exact match over any prefix', () => {
      expect(estimateCost('gpt-4.1', M, M)).toBeCloseTo(10.0, 6);
    });

    it('applies longest-prefix resolution to custom tables too', () => {
      const pricing = {
        'my-model': { input: 100, output: 100 },
        'my-model-mini': { input: 1, output: 1 },
      };
      expect(estimateCost('my-model-mini-2026-01-01', M, M, pricing)).toBe(2);
    });
  });

  describe('unknown-model warning (#38)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let stderrSpy: any;

    beforeEach(() => {
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });
    afterEach(() => {
      stderrSpy.mockRestore();
    });

    it('warns once per process when a model isn\'t in the table', () => {
      estimateCost('totally-new-model', 1000, 500);
      const writes = stderrSpy.mock.calls.map((c: unknown[]) => c[0] as string).join('');
      expect(writes).toContain('No pricing entry');
      expect(writes).toContain('totally-new-model');
      expect(writes).toContain('AgentConfig.usage.pricing');
    });

    it('does not warn twice for the same model', () => {
      estimateCost('repeat-model', 1, 1);
      estimateCost('repeat-model', 100, 100);
      estimateCost('repeat-model', 1000, 1000);
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    });

    it('keeps separate warning state for default vs custom tables', () => {
      // Same model name, different tables — both warnings should fire.
      estimateCost('only-in-custom', 1, 1); // unknown in default
      estimateCost('only-in-custom', 1, 1, { 'something-else': { input: 1, output: 1 } });
      expect(stderrSpy).toHaveBeenCalledTimes(2);
    });

    it('treats explicit DEFAULT_PRICING as the default table (not custom)', () => {
      // Regression guard: passing DEFAULT_PRICING explicitly used to be
      // misclassified as "custom" because the check was `pricing ?
      // 'custom' : 'default'`. UsageTracker always passes a pricing
      // table — for the default case it passes DEFAULT_PRICING — so the
      // bug would warn twice for the same model and label one of them
      // wrong.
      estimateCost('shared-model', 1, 1);                     // implicit default
      estimateCost('shared-model', 1, 1, DEFAULT_PRICING);    // explicit default
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const writes = stderrSpy.mock.calls
        .map((c: unknown[]) => c[0] as string)
        .join('');
      expect(writes).toContain('default table');
      expect(writes).not.toContain('custom table');
    });

    it('does not warn for known models', () => {
      estimateCost('claude-sonnet-4-6', 1000, 500);
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it('falls back to console.warn in environments without process.stderr', () => {
      // Simulate a browser-style runtime by stripping process.stderr
      // for the duration of the call.
      const realProc = (globalThis as { process?: unknown }).process;
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).process = undefined;
        estimateCost('browser-only-model', 1, 1);
        expect(consoleSpy).toHaveBeenCalledOnce();
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).process = realProc;
        consoleSpy.mockRestore();
      }
    });
  });
});

describe('UsageTracker', () => {
  it('accumulates records correctly', () => {
    const tracker = new UsageTracker();
    tracker.record(0, 'claude-sonnet-4-6', 1000, 500);
    tracker.record(1, 'claude-sonnet-4-6', 2000, 1000);

    const summary = tracker.getSummary();
    expect(summary.totalInputTokens).toBe(3000);
    expect(summary.totalOutputTokens).toBe(1500);
    expect(summary.steps).toBe(2);
    expect(summary.records).toHaveLength(2);
    expect(summary.totalCost).toBeGreaterThan(0);
  });

  it('per-run limit enforcement', async () => {
    const tracker = new UsageTracker({ perRunLimit: 0.001 });
    // Record enough to exceed limit
    tracker.record(0, 'claude-sonnet-4-6', 10000, 5000);

    const ok = await tracker.checkLimits();
    expect(ok).toBe(false);
  });

  it('per-run limit with callback override', async () => {
    const callback = vi.fn().mockResolvedValue(true);
    const tracker = new UsageTracker({
      perRunLimit: 0.001,
      onLimitExceeded: callback,
    });
    tracker.record(0, 'claude-sonnet-4-6', 10000, 5000);

    const ok = await tracker.checkLimits();
    expect(ok).toBe(true);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'perRun' }),
    );
  });

  it('per-day limit enforcement', async () => {
    const tracker = new UsageTracker({ perDayLimit: 0.001 });
    tracker.record(0, 'claude-sonnet-4-6', 10000, 5000);

    const ok = await tracker.checkLimits();
    expect(ok).toBe(false);
  });

  it('within limits returns true', async () => {
    const tracker = new UsageTracker({ perRunLimit: 100.0 });
    tracker.record(0, 'claude-sonnet-4-6', 100, 50);

    const ok = await tracker.checkLimits();
    expect(ok).toBe(true);
  });
});

describe('DEFAULT_PRICING', () => {
  it('has entries for major providers', () => {
    expect(DEFAULT_PRICING).toHaveProperty('claude-sonnet-4-6');
    expect(DEFAULT_PRICING).toHaveProperty('gpt-4o');
    expect(DEFAULT_PRICING).toHaveProperty('gemini-2.5-pro');
    expect(DEFAULT_PRICING).toHaveProperty('mistral-large');
  });

  it('covers the current Claude generation', () => {
    // A missing entry means estimateCost() returns 0, which silently
    // disables perRunLimit / perDayLimit for that model.
    for (const model of [
      'claude-fable-5',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
    ]) {
      expect(DEFAULT_PRICING).toHaveProperty(model);
      expect(estimateCost(model, 1_000_000, 0)).toBeGreaterThan(0);
    }
  });

  it.each([
    ['gpt-5.6-sol', 5.0, 30.0],
    ['gpt-5.6-terra', 2.0, 12.0],
    ['gpt-5.6-luna', 0.2, 1.2],
    ['gpt-5.6', 5.0, 30.0],
    ['gemini-3.6-flash', 1.5, 7.5],
    ['gemini-3.5-flash-lite', 0.3, 2.5],
    ['gemini-3.5-flash', 1.5, 9.0],
    ['glm-5.2', 1.4, 4.4],
    ['glm-5.1', 1.4, 4.4],
    ['glm-5-turbo', 1.2, 4.0],
    ['glm-5', 1.0, 3.2],
    ['glm-4.7-flashx', 0.07, 0.4],
    ['glm-4.7-flash', 0, 0],
    ['glm-4.7', 0.6, 2.2],
    ['glm-4.6', 0.6, 2.2],
    ['glm-4.5-airx', 1.1, 4.5],
    ['glm-4.5-air', 0.2, 1.1],
    ['glm-4.5-flash', 0, 0],
    ['glm-4.5-x', 2.2, 8.9],
    ['glm-4.5', 0.6, 2.2],
  ])('pins %s pricing at $%s input / $%s output per 1M tokens', (
    model,
    input,
    output,
  ) => {
    expect(DEFAULT_PRICING[model]).toEqual({ input, output });
  });

  it('prices every CLI per-provider default model', () => {
    // A CLI default missing from the table returns cost 0, which switches
    // off perRunLimit / perDayLimit for anyone who never passes --model.
    // Asserted against the real map so the two can't drift.
    for (const [provider, model] of DEFAULT_MODELS) {
      expect(
        DEFAULT_PRICING,
        `CLI default for "${provider}" (${model}) has no pricing entry`,
      ).toHaveProperty(model);
    }
  });
});
