import { describe, it, expect, vi } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { runAgentLoop, streamAgentLoop, buildOnStepFinish } from '../src/loop.js';
import { createMockModel } from '../src/testing/index.js';
import { UsageTracker } from '../src/usage.js';
import type { AgentConfig, ProgressEvent, PricingTable } from '../src/types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const s = (schema: z.ZodType): any => schema;

function mockModel(
  ...args: Parameters<typeof createMockModel>
): AgentConfig['model'] {
  return createMockModel(...args) as unknown as AgentConfig['model'];
}

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 't',
    name: 't',
    model: mockModel({ responses: [{ text: 'ok' }] }),
    maxIterations: 5,
    ...overrides,
  };
}

// ─── #27 M-03: tool-call limits (integration through the loop) ─────────

describe('M-03: tool-call rate limiting', () => {
  it('enforces maxToolCalls across the whole run', async () => {
    const executeFn = vi.fn().mockResolvedValue('ok');
    const config = baseConfig({
      model: mockModel({
        responses: [
          { toolCalls: [{ toolName: 'ping', args: {} }] },
        ],
      }),
      tools: {
        ping: tool({
          description: 'ping',
          inputSchema: s(z.object({})),
          execute: executeFn,
        }),
      },
      maxIterations: 10,
      toolLimits: { maxToolCalls: 3 },
    });

    await runAgentLoop(config, 'run');
    // The wrapper blocks the tool body once the cap is exceeded — real
    // executions never reach `executeFn`. The 4th+ calls short-circuit.
    expect(executeFn.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('resets maxToolCallsPerIteration between outer iterations', async () => {
    const executeFn = vi.fn().mockResolvedValue('ok');
    let callIdx = 0;
    const config = baseConfig({
      model: mockModel({
        responses: [
          {
            toolCalls: [
              { toolName: 'ping', args: { n: ++callIdx } },
              { toolName: 'ping', args: { n: ++callIdx } },
            ],
          },
          {
            toolCalls: [
              { toolName: 'ping', args: { n: ++callIdx } },
              { toolName: 'ping', args: { n: ++callIdx } },
            ],
          },
          { text: 'done' },
        ],
      }),
      tools: {
        ping: tool({
          description: 'ping',
          inputSchema: s(z.object({ n: z.number() })),
          execute: executeFn,
        }),
      },
      maxIterations: 3,
      toolLimits: { maxToolCallsPerIteration: 1 },
    });

    await runAgentLoop(config, 'run');
    // With reset-between-iterations semantics we expect at most 2 real
    // executions (1 per iteration × 2 iterations with tool calls).
    expect(executeFn.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('returns an error ToolResult (not a throw) so the model can see the limit', async () => {
    const events: ProgressEvent[] = [];
    const config = baseConfig({
      model: mockModel({
        responses: [
          { toolCalls: [{ toolName: 'ping', args: {} }] },
          { toolCalls: [{ toolName: 'ping', args: {} }] },
          { text: 'stopping' },
        ],
      }),
      tools: {
        ping: tool({
          description: 'ping',
          inputSchema: s(z.object({})),
          execute: async () => 'ok',
        }),
      },
      maxIterations: 3,
      toolLimits: { maxToolCalls: 1 },
    });

    for await (const e of streamAgentLoop(config, 'run')) events.push(e);

    const blocked = events.find(
      (e) => e.type === 'tool-result' && e.blocked === true,
    );
    expect(blocked).toBeDefined();
    expect(
      (blocked?.data as { reason?: string } | undefined)?.reason,
    ).toBe('tool-limit-run');
  });

  it('no limits configured → unbounded (backward compat)', async () => {
    // Without toolLimits, the wrapper must not apply any cap. We use
    // `stepCountIs` semantics: the mock replays the final response once
    // the list is exhausted, so a 3-iteration run with 1 call per iter
    // executes at least 3 times. Exact count can vary with the SDK's
    // inner step loop — just assert the cap didn't fire early.
    const executeFn = vi.fn().mockResolvedValue('ok');
    const config = baseConfig({
      model: mockModel({
        responses: [
          { toolCalls: [{ toolName: 'ping', args: {} }] },
        ],
      }),
      tools: {
        ping: tool({
          description: 'ping',
          inputSchema: s(z.object({})),
          execute: executeFn,
        }),
      },
      maxIterations: 3,
    });
    await runAgentLoop(config, 'run');
    expect(executeFn.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

// ─── #31 M-07: per-step hard spending cap (unit test the hook) ──────────

describe('M-07: buildOnStepFinish', () => {
  const pricing: PricingTable = {
    'cap-test': { input: 1000, output: 1000 }, // $1000/M tokens
  };

  const stepWithUsage = (inputTokens: number, outputTokens: number): unknown => ({
    usage: { inputTokens, outputTokens },
  });

  it('returns undefined when usage is disabled', () => {
    const tracker = new UsageTracker({ pricing });
    const ctrl = new AbortController();
    const config = baseConfig({
      usage: { enabled: false, pricing, limits: { perRun: 1 } },
    });
    expect(buildOnStepFinish(config, tracker, ctrl, 0)).toBeUndefined();
  });

  it('records step usage even without a perRun limit (PR #65 review)', () => {
    // The hook became the authoritative per-step recorder so that
    // mid-iteration aborts land in the tracker. It therefore fires
    // for any usage-tracking-enabled config, just skips the abort
    // branch when no hard cap is configured.
    const tracker = new UsageTracker({ pricing });
    const ctrl = new AbortController();
    const config = baseConfig({ usage: { pricing } });
    const hook = buildOnStepFinish(config, tracker, ctrl, 0);
    expect(hook).toBeDefined();
    hook!(stepWithUsage(10, 20));
    expect(tracker.getSummary().records).toHaveLength(1);
    expect(ctrl.signal.aborted).toBe(false);
  });

  it('aborts the controller when projected cost crosses the hard cap', () => {
    const tracker = new UsageTracker({ pricing });
    const ctrl = new AbortController();
    const config = baseConfig({
      model: mockModel({ responses: [{ text: 'x' }], modelId: 'cap-test' }),
      usage: {
        pricing,
        limits: { perRun: 0.01 },
        hardLimitMultiplier: 1, // hard cap == soft cap
      },
    });
    const hook = buildOnStepFinish(config, tracker, ctrl, 0);
    expect(hook).toBeDefined();

    // Step cost: 10/1M × 1000 + 20/1M × 1000 = $0.03.
    // Projected: 0 + 0.03 = 0.03 >= 0.01 → abort.
    hook!(stepWithUsage(10, 20));
    expect(ctrl.signal.aborted).toBe(true);
    const reason = ctrl.signal.reason as Error | undefined;
    expect(reason?.message).toMatch(/Hard spending cap reached/);
  });

  it('does not abort when projected cost stays under the hard cap', () => {
    const tracker = new UsageTracker({ pricing });
    const ctrl = new AbortController();
    const config = baseConfig({
      model: mockModel({ responses: [{ text: 'x' }], modelId: 'cap-test' }),
      usage: {
        pricing,
        limits: { perRun: 1.0 },
        hardLimitMultiplier: 1.25, // hard = 1.25
      },
    });
    const hook = buildOnStepFinish(config, tracker, ctrl, 0);
    hook!(stepWithUsage(10, 20)); // $0.03 projected, well under 1.25
    expect(ctrl.signal.aborted).toBe(false);
  });

  it('factors existing tracker spend into the projection', () => {
    const tracker = new UsageTracker({ pricing });
    // Pre-load $0.02 of spend into the tracker.
    tracker.record(0, 'cap-test', 10, 10); // 20/1M × 1000 = $0.02
    const ctrl = new AbortController();
    const config = baseConfig({
      model: mockModel({ responses: [{ text: 'x' }], modelId: 'cap-test' }),
      usage: {
        pricing,
        limits: { perRun: 0.03 },
        hardLimitMultiplier: 1, // hard = 0.03
      },
    });
    const hook = buildOnStepFinish(config, tracker, ctrl, 0);
    // Next step adds $0.03, so projected = 0.02 + 0.03 = 0.05 >= 0.03.
    hook!(stepWithUsage(10, 20));
    expect(ctrl.signal.aborted).toBe(true);
  });

  it('default hardLimitMultiplier is 1.25', () => {
    const tracker = new UsageTracker({ pricing });
    const ctrl = new AbortController();
    const config = baseConfig({
      model: mockModel({ responses: [{ text: 'x' }], modelId: 'cap-test' }),
      usage: {
        pricing,
        limits: { perRun: 0.03 }, // cost equals limit → soft trip, not hard
      },
    });
    const hook = buildOnStepFinish(config, tracker, ctrl, 0);
    // Projected 0.03 < 0.03 × 1.25 = 0.0375 → no abort.
    hook!(stepWithUsage(10, 20));
    expect(ctrl.signal.aborted).toBe(false);
  });

  it('ignores steps without usage info', () => {
    const tracker = new UsageTracker({ pricing });
    const ctrl = new AbortController();
    const config = baseConfig({
      model: mockModel({ responses: [{ text: 'x' }], modelId: 'cap-test' }),
      usage: { pricing, limits: { perRun: 0.0001 }, hardLimitMultiplier: 1 },
    });
    const hook = buildOnStepFinish(config, tracker, ctrl, 0);
    hook!({}); // no usage
    expect(ctrl.signal.aborted).toBe(false);
  });

  it('accumulates across inner steps in the same iteration (Codex #65 P1)', () => {
    // Before this fix, the hook only projected against cross-iteration
    // totals, so N small inner steps could each stay under the cap
    // while cumulatively exceeding it. The new implementation records
    // each step into the tracker so the running total reflects
    // intra-iteration accumulation.
    const tracker = new UsageTracker({ pricing });
    const ctrl = new AbortController();
    const config = baseConfig({
      model: mockModel({ responses: [{ text: 'x' }], modelId: 'cap-test' }),
      usage: {
        pricing,
        limits: { perRun: 0.04 }, // per-step cost is $0.03
        hardLimitMultiplier: 1,
      },
    });
    const hook = buildOnStepFinish(config, tracker, ctrl, 0);
    hook!(stepWithUsage(10, 20)); // running total $0.03 < cap 0.04
    expect(ctrl.signal.aborted).toBe(false);
    hook!(stepWithUsage(10, 20)); // running total $0.06 >= cap 0.04
    expect(ctrl.signal.aborted).toBe(true);
  });

  it('records the aborted step before tripping (Codex #65 P2)', () => {
    // The abort-causing step must be in the tracker, otherwise
    // RunResult.usage undercounts the actual spend at termination.
    const tracker = new UsageTracker({ pricing });
    const ctrl = new AbortController();
    const config = baseConfig({
      model: mockModel({ responses: [{ text: 'x' }], modelId: 'cap-test' }),
      usage: {
        pricing,
        limits: { perRun: 0.01 }, // trip on first step ($0.03 > 0.01)
        hardLimitMultiplier: 1,
      },
    });
    const hook = buildOnStepFinish(config, tracker, ctrl, 0);
    hook!(stepWithUsage(10, 20));
    expect(ctrl.signal.aborted).toBe(true);
    expect(tracker.getSummary().records).toHaveLength(1);
    expect(tracker.getSummary().totalCost).toBeCloseTo(0.03, 5);
  });
});
