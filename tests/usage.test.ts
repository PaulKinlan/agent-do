import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  UsageTracker,
  estimateCost,
  DEFAULT_PRICING,
  resetPricingWarnings,
} from '../src/usage.js';

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
});
