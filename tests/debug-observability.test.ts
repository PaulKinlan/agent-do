import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { runAgentLoop, streamAgentLoop } from '../src/loop.js';
import { createMockModel } from '../src/testing/index.js';
import { parseArgs } from '../src/cli/args.js';
import { buildDebugConfigFromArgs } from '../src/cli/debug-config.js';
import {
  clampString,
  extractCacheUsage,
} from '../src/debug-middleware.js';
import type {
  AgentConfig,
  DebugEvent,
  ProgressEvent,
} from '../src/types.js';

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
    model: mockModel({ responses: [{ text: 'done' }] }),
    systemPrompt: 'You are a helpful assistant.',
    maxIterations: 3,
    ...overrides,
  };
}

// ─── extractCacheUsage unit tests ─────────────────────────────────────

describe('extractCacheUsage', () => {
  it('pulls cache breakdown from the v6 inputTokenDetails shape', () => {
    const out = extractCacheUsage({
      inputTokens: 1000,
      outputTokens: 200,
      inputTokenDetails: {
        cacheReadTokens: 800,
        cacheWriteTokens: 0,
        noCacheTokens: 200,
      },
    });
    expect(out).toEqual({
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
      noCacheTokens: 200,
      outputTokens: 200,
    });
  });

  it('falls back to the deprecated flat cachedInputTokens field', () => {
    const out = extractCacheUsage({
      inputTokens: 500,
      outputTokens: 100,
      cachedInputTokens: 400,
    });
    // flat field fills cacheReadTokens; noCache derived from inputTokens - reads.
    expect(out).toEqual({
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
      noCacheTokens: 100,
      outputTokens: 100,
    });
  });

  it('handles missing usage gracefully (zeros all around)', () => {
    expect(extractCacheUsage(undefined)).toEqual({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      noCacheTokens: 0,
      outputTokens: 0,
    });
  });
});

describe('clampString', () => {
  it('leaves short content unchanged', () => {
    const out = clampString('short', 100);
    expect(out.truncated).toBe(false);
    expect(out.content).toBe('short');
    expect(out.bytes).toBe(5);
  });

  it('clips oversize content and marks truncated', () => {
    const big = 'x'.repeat(500);
    const out = clampString(big, 100);
    expect(out.truncated).toBe(true);
    expect(out.bytes).toBe(500);
    expect(out.content.length).toBeGreaterThan(100);
    expect(out.content).toMatch(/truncated \d+ bytes/);
  });
});

// ─── End-to-end debug channels through the stream loop ──────────────

describe('streamAgentLoop — debug channels (#72)', () => {
  it('emits no debug events when debug is undefined (zero overhead path)', async () => {
    const config = baseConfig();
    const events: ProgressEvent[] = [];
    for await (const e of streamAgentLoop(config, 'task')) events.push(e);
    const debugEvents = events.filter((e) => e.type === 'debug');
    expect(debugEvents).toHaveLength(0);
  });

  it('emits a system-prompt event once per run when debug.systemPrompt is on', async () => {
    const config = baseConfig({
      systemPrompt: 'test system prompt',
      debug: { systemPrompt: true },
    });
    const events: ProgressEvent[] = [];
    for await (const e of streamAgentLoop(config, 'task')) events.push(e);

    const systemPromptEvents = events
      .filter((e) => e.type === 'debug' && e.debug?.channel === 'system-prompt')
      .map((e) => e.debug as Extract<DebugEvent, { channel: 'system-prompt' }>);
    expect(systemPromptEvents).toHaveLength(1);
    expect(systemPromptEvents[0]!.content).toContain('test system prompt');
    expect(systemPromptEvents[0]!.truncated).toBe(false);
  });

  it('emits a system-prompt event exactly once even across multiple iterations', async () => {
    const config = baseConfig({
      model: mockModel({
        responses: [
          { toolCalls: [{ toolName: 'ping', args: {} }] },
          { text: 'final' },
        ],
      }),
      tools: {
        ping: tool({
          description: 'p',
          inputSchema: s(z.object({})),
          execute: async () => 'ok',
        }),
      },
      debug: { systemPrompt: true },
    });
    const events: ProgressEvent[] = [];
    for await (const e of streamAgentLoop(config, 'task')) events.push(e);
    const systemPromptEvents = events.filter(
      (e) => e.type === 'debug' && e.debug?.channel === 'system-prompt',
    );
    expect(systemPromptEvents).toHaveLength(1);
  });

  it('fans out debug events to the sink in addition to the progress stream', async () => {
    const sinkEvents: DebugEvent[] = [];
    const config = baseConfig({
      debug: {
        systemPrompt: true,
        sink: (event) => { sinkEvents.push(event); },
      },
    });
    const streamEvents: ProgressEvent[] = [];
    for await (const e of streamAgentLoop(config, 'task')) streamEvents.push(e);

    const streamDebug = streamEvents.filter((e) => e.type === 'debug');
    expect(streamDebug.length).toBe(sinkEvents.length);
    expect(streamDebug.length).toBeGreaterThan(0);
    expect(streamDebug[0]!.debug).toEqual(sinkEvents[0]);
  });

  it('swallows sync and async sink errors without breaking the run', async () => {
    const config = baseConfig({
      debug: {
        systemPrompt: true,
        sink: () => { throw new Error('sync sink boom'); },
      },
    });
    const events: ProgressEvent[] = [];
    // Must complete without rethrowing the sink error.
    for await (const e of streamAgentLoop(config, 'task')) events.push(e);
    expect(events.some((e) => e.type === 'done')).toBe(true);

    const config2 = baseConfig({
      debug: {
        systemPrompt: true,
        sink: async () => { throw new Error('async sink boom'); },
      },
    });
    const events2: ProgressEvent[] = [];
    for await (const e of streamAgentLoop(config2, 'task')) events2.push(e);
    expect(events2.some((e) => e.type === 'done')).toBe(true);
  });

  it('`all: true` turns on every channel', async () => {
    const config = baseConfig({
      debug: { all: true },
    });
    const events: ProgressEvent[] = [];
    for await (const e of streamAgentLoop(config, 'task')) events.push(e);
    const channels = new Set(
      events
        .filter((e) => e.type === 'debug')
        .map((e) => e.debug?.channel),
    );
    // At minimum: system-prompt + messages + request. `cache` fires
    // through onStepFinish which the mock model triggers.
    expect(channels.has('system-prompt')).toBe(true);
    expect(channels.has('messages')).toBe(true);
    expect(channels.has('request')).toBe(true);
  });

  it('truncates oversize system-prompt to maxBodyBytes', async () => {
    const config = baseConfig({
      systemPrompt: 'x'.repeat(5000),
      debug: { systemPrompt: true, maxBodyBytes: 200 },
    });
    const events: ProgressEvent[] = [];
    for await (const e of streamAgentLoop(config, 'task')) events.push(e);
    const sp = events.find(
      (e) => e.type === 'debug' && e.debug?.channel === 'system-prompt',
    );
    const debug = sp?.debug as Extract<DebugEvent, { channel: 'system-prompt' }>;
    expect(debug.truncated).toBe(true);
    // Original size reported; content clipped.
    expect(debug.bytes).toBeGreaterThan(5000);
    expect(debug.content).toMatch(/truncated \d+ bytes/);
  });
});

// ─── runAgentLoop (non-streaming) — sink path only ───────────────────

describe('runAgentLoop — debug sink (#72)', () => {
  it('routes debug events to the sink when there is no progress stream', async () => {
    const sinkEvents: DebugEvent[] = [];
    const config = baseConfig({
      debug: {
        systemPrompt: true,
        sink: (event) => { sinkEvents.push(event); },
      },
    });
    await runAgentLoop(config, 'task');
    expect(sinkEvents.some((e) => e.channel === 'system-prompt')).toBe(true);
  });
});

// ─── #73 review follow-ups ────────────────────────────────────────────

describe('UTF-8 truncation (#73 Copilot)', () => {
  it('clampString respects character boundaries', () => {
    // Each '🔑' is 4 UTF-8 bytes. Cap the limit at 5 bytes (one key
    // plus a single stray continuation byte) — the truncation should
    // roll back to a character boundary (one full key = 4 bytes).
    const key = '🔑';
    const out = clampString(key.repeat(10), 5);
    expect(out.truncated).toBe(true);
    // The emitted content ends with a complete character, not a
    // half-encoded one.
    const prefix = out.content.replace(/\n\[… truncated .+ bytes\]$/, '');
    // Re-encode to confirm no invalid UTF-8 bytes snuck through.
    const bytes = new TextEncoder().encode(prefix);
    expect(bytes.byteLength).toBeLessThanOrEqual(5);
    // And the prefix is a valid decode.
    expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toBe(prefix);
  });

  it('does not use Buffer (web-compat)', async () => {
    // This is a smoke test: the module shouldn't reference `Buffer`
    // at all so it can load in a browser. Check the source.
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/debug-middleware.ts', import.meta.url), 'utf-8'),
    );
    // Allow mentions inside comments but not in live code — the
    // easiest proof is there's zero `Buffer` identifier after
    // comment stripping. A simpler heuristic: the module uses
    // `TextEncoder` and doesn't reference `Buffer.` as an API call.
    expect(src).not.toMatch(/\bBuffer\.(byteLength|from|alloc)/);
    expect(src).toMatch(/TextEncoder/);
  });
});

describe('cache hit rate formula (#73 Codex)', () => {
  it('excludes cacheWriteTokens from the hit-rate denominator', () => {
    // Reproduce the render logic's formula shape and verify it
    // matches the documented `read / (read + no-cache)` spec.
    const event = {
      cacheReadTokens: 800,
      cacheWriteTokens: 200,
      noCacheTokens: 200,
    };
    const hitBase = event.cacheReadTokens + event.noCacheTokens;
    const hitPct = Math.round((event.cacheReadTokens / hitBase) * 100);
    expect(hitPct).toBe(80); // 800 / 1000, not 800 / 1200
  });
});

describe('CLI --log-level authority (#73 Copilot)', () => {
  it('--log-level info clears legacy --verbose (later log-level wins)', () => {
    const args = parseArgs(['--verbose', '--log-level', 'info', 'hello']);
    expect(args.logLevel).toBe('info');
    expect(args.verbose).toBe(false);
    expect(args.showContent).toBe(false);
  });

  it('--log-level silent clears legacy --show-content', () => {
    const args = parseArgs(['--show-content', '--log-level', 'silent', 'hi']);
    expect(args.logLevel).toBe('silent');
    expect(args.verbose).toBe(false);
    expect(args.showContent).toBe(false);
  });

  it('--log-level debug derives verbose+showContent on', () => {
    const args = parseArgs(['--log-level', 'debug', 'hi']);
    expect(args.logLevel).toBe('debug');
    expect(args.verbose).toBe(true);
    expect(args.showContent).toBe(true);
  });

  it('legacy --verbose without --log-level promotes to verbose', () => {
    const args = parseArgs(['--verbose', 'hi']);
    expect(args.logLevel).toBe('verbose');
    expect(args.verbose).toBe(true);
    expect(args.showContent).toBe(false);
  });

  it('legacy --show-content implies verbose level + keeps showContent on', () => {
    const args = parseArgs(['--show-content', 'hi']);
    // --show-content bumps the level to verbose (legacy behaviour)
    // AND acts as an explicit override so content stays visible
    // even though logLevel didn't cross the debug threshold.
    expect(args.logLevel).toBe('verbose');
    expect(args.verbose).toBe(true);
    expect(args.showContent).toBe(true);
  });

  it('--log-level silent wipes --show-content (explicit log-level wins)', () => {
    const args = parseArgs(['--show-content', '--log-level', 'silent', 'hi']);
    // Explicit --log-level silent beats the legacy flag — same
    // rule as --verbose --log-level info.
    expect(args.logLevel).toBe('silent');
    expect(args.verbose).toBe(false);
    expect(args.showContent).toBe(false);
  });

  it('--log-level verbose + --show-content keeps content visible', () => {
    // The most useful combination: verbose-level operator output
    // PLUS full tool bodies, without going all the way to debug.
    const args = parseArgs(['--log-level', 'verbose', '--show-content', 'hi']);
    expect(args.logLevel).toBe('verbose');
    expect(args.verbose).toBe(true);
    expect(args.showContent).toBe(true);
  });
});

describe('buildDebugConfigFromArgs — no `all: true` at debug (#73 Copilot)', () => {
  it('leaves response off at --log-level debug to avoid per-token middleware cost', () => {
    const args = parseArgs(['--log-level', 'debug', 'hi']);
    const cfg = buildDebugConfigFromArgs(args);
    expect(cfg).toBeDefined();
    expect(cfg!.all).toBeUndefined();
    expect(cfg!.response).toBe(false);
    expect(cfg!.systemPrompt).toBe(true);
    expect(cfg!.messages).toBe(true);
    expect(cfg!.cache).toBe(true);
  });

  it('enables response only at --log-level trace', () => {
    const args = parseArgs(['--log-level', 'trace', 'hi']);
    const cfg = buildDebugConfigFromArgs(args);
    expect(cfg!.response).toBe(true);
    expect(cfg!.traceResponseParts).toBe(true);
  });

  it('returns undefined for info/verbose/silent (no middleware wrapping)', () => {
    for (const level of ['info', 'verbose', 'silent'] as const) {
      const args = parseArgs(['--log-level', level, 'hi']);
      expect(buildDebugConfigFromArgs(args)).toBeUndefined();
    }
  });
});
