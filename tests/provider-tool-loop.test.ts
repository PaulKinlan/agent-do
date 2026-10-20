/**
 * Provider-executed tool calls at the loop level (agent-do-cgh).
 *
 * The AI SDK runs provider-executed tools server-side and never routes
 * them through local `execute`, so the per-call wrapper cannot count or
 * observe them. The loop closes the gap: it counts `tool-call` stream
 * parts carrying `providerExecuted: true` into the shared tool-call
 * counters, enforces the run-level limit post-hoc (no further iterations
 * once the observed total exceeds the cap — the provider-side cost of
 * the current step is already spent), fires `onPostToolUse` for the
 * observed results, and caches a normalised ToolResult so the stream's
 * `tool-result` enrichment covers them too.
 *
 * `onPreToolUse` is deliberately NOT fired for provider-executed calls:
 * its deny/stop decisions would be unenforceable after server-side
 * execution, and a hook that lies is worse than a hook that stays
 * silent.
 */
import { describe, it, expect, vi } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { runAgentLoop, streamAgentLoop } from '../src/loop.js';
import { createMockModel } from '../src/testing/index.js';
import type { AgentConfig, ProgressEvent } from '../src/types.js';

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

function providerToolSet(): AgentConfig['tools'] {
  return {
    web: {
      type: 'provider',
      name: 'webSearch',
      inputSchema: s(z.object({})),
    },
  } as unknown as AgentConfig['tools'];
}

describe('provider-executed tool calls: toolLimits enforcement (run loop)', () => {
  it('stops scheduling iterations once provider calls push the total over the cap', async () => {
    const model = mockModel({
      responses: [
        {
          toolCalls: [{ toolName: 'web', args: {}, providerExecuted: true }],
          providerToolResults: [{ toolName: 'web', result: { answer: 42 } }],
        },
        {
          toolCalls: [{ toolName: 'web', args: {}, providerExecuted: true }],
          providerToolResults: [{ toolName: 'web', result: { answer: 43 } }],
        },
        { text: 'unreachable final answer' },
      ],
    });
    let modelCalls = 0;
    const anyModel = model as unknown as {
      doStream: (opts: unknown) => Promise<{ stream: ReadableStream }>;
    };
    const origDoStream = anyModel.doStream.bind(anyModel);
    anyModel.doStream = async (opts) => {
      modelCalls += 1;
      return origDoStream(opts);
    };
    const onComplete = vi.fn();
    const result = await runAgentLoop(
      baseConfig({
        model,
        tools: providerToolSet(),
        permissions: { mode: 'accept-all' },
        toolLimits: { maxToolCalls: 1 },
        maxIterations: 10,
        hooks: { onComplete },
      }),
      'run',
    );
    // Two provider calls happened (cost already spent), then the run
    // stopped: the third model call — and any further provider calls —
    // never happened.
    expect(modelCalls).toBe(2);
    expect(result.steps).toBe(2);
    expect(result.aborted).toBe(true);
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ aborted: true }),
    );
  });

  it('keeps local-only overshoot semantics unchanged (wrapper denial, run completes)', async () => {
    const executeFn = vi.fn().mockResolvedValue('ok');
    const config = baseConfig({
      model: mockModel({
        responses: [
          { toolCalls: [{ toolName: 'ping', args: {} }] },
          { toolCalls: [{ toolName: 'ping', args: {} }] },
          { text: 'final answer' },
        ],
      }),
      tools: {
        ping: tool({
          description: 'ping',
          inputSchema: s(z.object({})),
          execute: executeFn,
        }),
      },
      permissions: { mode: 'accept-all' },
      toolLimits: { maxToolCalls: 1 },
      maxIterations: 10,
    });
    const result = await runAgentLoop(config, 'run');
    // Local calls are denied per-call by the wrapper; the run is NOT
    // hard-stopped and the model gets its final-answer turn.
    expect(result.aborted).toBe(false);
    expect(result.text).toBe('final answer');
    expect(executeFn).toHaveBeenCalledTimes(1);
  });
});

describe('provider-executed tool calls: per-iteration budget (agent-do-7kf)', () => {
  const twoProviderCalls = {
    toolCalls: [
      { toolName: 'web', args: {}, providerExecuted: true },
      { toolName: 'news', args: {}, providerExecuted: true },
    ],
    providerToolResults: [
      { toolName: 'web', result: 'w' },
      { toolName: 'news', result: 'n' },
    ],
  };

  function providerToolSet2(): AgentConfig['tools'] {
    return {
      web: { type: 'provider', name: 'webSearch', inputSchema: s(z.object({})) },
      news: { type: 'provider', name: 'newsSearch', inputSchema: s(z.object({})) },
    } as unknown as AgentConfig['tools'];
  }

  it('a step whose provider calls exceed maxToolCallsPerIteration stops the run post-hoc', async () => {
    let modelCalls = 0;
    const model = mockModel({
      responses: [twoProviderCalls, { text: 'unreachable' }],
    });
    const anyModel = model as unknown as {
      doStream: (opts: unknown) => Promise<{ stream: ReadableStream }>;
    };
    const origDoStream = anyModel.doStream.bind(anyModel);
    anyModel.doStream = async (opts) => {
      modelCalls += 1;
      return origDoStream(opts);
    };
    const config = baseConfig({
      model,
      tools: providerToolSet2(),
      permissions: { mode: 'accept-all' },
      // Run-level cap absent: the per-iteration trip is under test.
      toolLimits: { maxToolCallsPerIteration: 1 },
      maxIterations: 10,
    });
    const events: ProgressEvent[] = [];
    for await (const ev of streamAgentLoop(config, 'run')) events.push(ev);
    // Only one model call: the run stopped after the burst step.
    expect(modelCalls).toBe(1);
    expect(events.some((e) => e.type === 'error' && /tool-call limit/i.test(e.content))).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('local calls are never denied by provider counts (order-independence)', async () => {
    const executeFn = vi.fn().mockResolvedValue('pong');
    // Local call LAST in the response — the order that used to deny it.
    const model = mockModel({
      responses: [
        {
          toolCalls: [
            { toolName: 'web', args: {}, providerExecuted: true },
            { toolName: 'ping', args: {} },
          ],
          providerToolResults: [{ toolName: 'web', result: 'ok' }],
        },
        { text: 'final' },
      ],
    });
    const config = baseConfig({
      model,
      tools: {
        ...providerToolSet(),
        ping: tool({
          description: 'ping',
          inputSchema: s(z.object({})),
          execute: executeFn,
        }),
      },
      permissions: { mode: 'accept-all' },
      toolLimits: { maxToolCallsPerIteration: 1 },
      maxIterations: 10,
    });
    const result = await runAgentLoop(config, 'run');
    // The local call executed (its per-iteration budget is local-only now)...
    expect(executeFn).toHaveBeenCalledTimes(1);
    // ...and the single provider call did not trip the cap (1 not > 1).
    expect(result.aborted).toBe(false);
    expect(result.text).toBe('final');
  });

  it('mixed local+provider over the per-iteration cap: local executes, run stops after the step', async () => {
    const executeFn = vi.fn().mockResolvedValue('pong');
    const model = mockModel({
      responses: [
        {
          ...twoProviderCalls,
          toolCalls: [
            ...twoProviderCalls.toolCalls,
            { toolName: 'ping', args: {} },
          ],
        },
        { text: 'unreachable' },
      ],
    });
    const config = baseConfig({
      model,
      tools: {
        ...providerToolSet2(),
        ping: tool({
          description: 'ping',
          inputSchema: s(z.object({})),
          execute: executeFn,
        }),
      },
      permissions: { mode: 'accept-all' },
      toolLimits: { maxToolCallsPerIteration: 1 },
      maxIterations: 10,
    });
    const result = await runAgentLoop(config, 'run');
    expect(executeFn).toHaveBeenCalledTimes(1);
    expect(result.aborted).toBe(true);
    expect(result.steps).toBe(1);
  });
});

describe('provider-executed tool calls: hooks and result enrichment', () => {
  it('stream loop: fires onPostToolUse (never onPreToolUse) and enriches the tool-result event', async () => {
    const onPreToolUse = vi.fn();
    const onPostToolUse = vi.fn();
    const config = baseConfig({
      model: mockModel({
        responses: [
          {
            toolCalls: [{ toolName: 'web', args: {}, providerExecuted: true }],
            providerToolResults: [{ toolName: 'web', result: { answer: 42 } }],
          },
          { text: 'done' },
        ],
      }),
      tools: providerToolSet(),
      permissions: { mode: 'accept-all' },
      emitFullResult: true,
      hooks: { onPreToolUse, onPostToolUse },
    });
    const events: ProgressEvent[] = [];
    for await (const ev of streamAgentLoop(config, 'run')) events.push(ev);

    // The tool-call progress event marks the call as provider-executed.
    const callEvent = events.find((e) => e.type === 'tool-call');
    expect(callEvent?.providerExecuted).toBe(true);
    expect(callEvent?.toolName).toBe('web');

    // The tool-result event carries a bounded descriptor, NOT the payload
    // (P1 finding): summary flows by default, so the provider payload only
    // appears behind emitFullResult, inside the cached ToolResult.
    const resultEvent = events.find((e) => e.type === 'tool-result');
    expect(resultEvent?.providerExecuted).toBe(true);
    expect(resultEvent?.summary).toBe('[web] provider-executed result (13 bytes)');
    expect(resultEvent?.summary).not.toContain('answer');
    expect(resultEvent?.data).toEqual({ providerExecuted: true, bytes: 13 });
    expect(resultEvent?.toolResult).toEqual({
      modelContent: '{"answer":42}',
      userSummary: '[web] provider-executed result (13 bytes)',
      data: { providerExecuted: true, bytes: 13 },
    });

    // Post hook observes the server-side result (full fidelity via the
    // ToolResult's modelContent); pre hook stays silent — its decisions
    // would be unenforceable after server-side execution.
    expect(onPostToolUse).toHaveBeenCalledTimes(1);
    expect(onPostToolUse).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'web',
        providerExecuted: true,
        step: 0,
        result: expect.objectContaining({ modelContent: '{"answer":42}' }),
      }),
    );
    expect(onPreToolUse).not.toHaveBeenCalled();
  });

  it('stream loop: provider tool errors surface as bounded events, not payload leaks', async () => {
    const onPostToolUse = vi.fn();
    const config = baseConfig({
      model: mockModel({
        responses: [
          {
            toolCalls: [{ toolName: 'web', args: {}, providerExecuted: true }],
            providerToolResults: [
              { toolName: 'web', result: 'E'.repeat(1000), isError: true },
            ],
          },
          { text: 'done' },
        ],
      }),
      tools: providerToolSet(),
      permissions: { mode: 'accept-all' },
      hooks: { onPostToolUse },
    });
    const events: ProgressEvent[] = [];
    for await (const ev of streamAgentLoop(config, 'run')) events.push(ev);

    const errEvent = events.find((e) => e.type === 'tool-result');
    expect(errEvent).toBeDefined();
    expect(errEvent?.providerExecuted).toBe(true);
    // Bounded: the 1000-byte server error is clipped in the summary.
    expect(errEvent?.summary).toContain('PROVIDER ERROR');
    expect(errEvent?.summary!.length).toBeLessThan(300);
    expect(onPostToolUse).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'web', providerExecuted: true }),
    );
  });

  it('run loop: fires onPostToolUse for provider-executed results', async () => {
    const onPostToolUse = vi.fn();
    const config = baseConfig({
      model: mockModel({
        responses: [
          {
            toolCalls: [{ toolName: 'web', args: {}, providerExecuted: true }],
            providerToolResults: [{ toolName: 'web', result: 'payload' }],
          },
          { text: 'done' },
        ],
      }),
      tools: providerToolSet(),
      permissions: { mode: 'accept-all' },
      hooks: { onPostToolUse },
    });
    await runAgentLoop(config, 'run');
    expect(onPostToolUse).toHaveBeenCalledTimes(1);
    expect(onPostToolUse).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'web',
        providerExecuted: true,
      }),
    );
  });

  it('local tools keep firing onPreToolUse (wrapper path unchanged)', async () => {
    const onPreToolUse = vi.fn();
    const config = baseConfig({
      model: mockModel({
        responses: [
          { toolCalls: [{ toolName: 'ping', args: {} }] },
          { text: 'done' },
        ],
      }),
      tools: {
        ping: tool({
          description: 'ping',
          inputSchema: s(z.object({})),
          execute: async () => 'pong',
        }),
      },
      permissions: { mode: 'accept-all' },
      hooks: { onPreToolUse },
    });
    await runAgentLoop(config, 'run');
    expect(onPreToolUse).toHaveBeenCalledTimes(1);
    expect(onPreToolUse).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'ping' }),
    );
  });
});
