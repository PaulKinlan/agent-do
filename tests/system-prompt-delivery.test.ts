/**
 * Regression guard: the system prompt must actually reach the provider.
 *
 * The AI SDK renamed `system` to `instructions` in v7 and kept `system`
 * as a deprecated alias. That is exactly the shape of change that breaks
 * silently — a future major that *drops* the old key would leave every
 * agent running with no system prompt, and no existing test would notice,
 * because the loop's own behaviour (steps, tools, usage) is unchanged.
 *
 * These tests assert against what the model actually receives, so the
 * wiring is pinned independently of whichever option name is current.
 */
import { describe, it, expect } from 'vitest';
import { runAgentLoop } from '../src/loop.js';
import { createMockModel } from '../src/testing/index.js';
import type { AgentConfig } from '../src/types.js';

/** Capture the `prompt` passed to the provider on each doStream call. */
function captureProviderPrompts(model: unknown): unknown[] {
  const captured: unknown[] = [];
  const m = model as { doStream: (opts: { prompt: unknown }) => unknown };
  const original = m.doStream.bind(m);
  m.doStream = (opts: { prompt: unknown }) => {
    captured.push(opts.prompt);
    return original(opts);
  };
  return captured;
}

describe('system prompt delivery', () => {
  it('forwards AgentConfig.systemPrompt to the provider', async () => {
    const model = createMockModel({ responses: [{ text: 'ok' }] });
    const prompts = captureProviderPrompts(model);

    await runAgentLoop(
      {
        id: 'sys-probe',
        name: 'Sys Probe',
        model: model as never,
        systemPrompt: 'SENTINEL_SYSTEM_PROMPT',
        tools: {},
      } as AgentConfig,
      'hello',
    );

    expect(prompts.length).toBeGreaterThan(0);
    expect(JSON.stringify(prompts)).toContain('SENTINEL_SYSTEM_PROMPT');
  });

  it('delivers it as a system-role entry, not buried in the user turn', async () => {
    const model = createMockModel({ responses: [{ text: 'ok' }] });
    const prompts = captureProviderPrompts(model);

    await runAgentLoop(
      {
        id: 'sys-probe-2',
        name: 'Sys Probe 2',
        model: model as never,
        systemPrompt: 'SENTINEL_SYSTEM_PROMPT',
        tools: {},
      } as AgentConfig,
      'hello',
    );

    const first = prompts[0] as Array<{ role: string; content: unknown }>;
    const system = first.find((m) => m.role === 'system');
    expect(system, 'no system-role message reached the provider').toBeDefined();
    expect(JSON.stringify(system)).toContain('SENTINEL_SYSTEM_PROMPT');
  });
});
