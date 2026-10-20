/**
 * Registration-time gating of provider-executed tools (agent-do-dul).
 *
 * Provider-native tools (Anthropic bash/textEditor/computer, OpenAI
 * applyPatch, Google codeExecution, ...) have no local `execute` — the
 * provider runs them server-side, and the AI SDK never routes
 * providerExecuted tool calls through local execute. The per-call
 * wrapper therefore cannot intercept them, so the permission gate moves
 * to buildTools(): a policy that would not allow the tool keeps it out
 * of the ToolSet entirely — the provider never sees it, so it can
 * never run.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ToolSet } from 'ai';
import {
  buildTools,
  type ToolCallCounters,
  type ToolResultCache,
} from '../src/tools-build.js';
import type { AgentConfig, PermissionConfig } from '../src/types.js';
import { InMemorySkillStore } from '../src/skills.js';

/** A provider-executed tool as the AI SDK's factory functions build them. */
function providerTool(name: string): ToolSet[string] {
  return {
    type: 'provider',
    id: `stub__${name}`,
    name,
    description: `${name} runs server-side`,
    inputSchema: {},
  } as unknown as ToolSet[string];
}

function locallyExecutedTool(): ToolSet[string] {
  return {
    description: 'local echo',
    inputSchema: {},
    execute: async () => 'echo-result',
  } as unknown as ToolSet[string];
}

function build(config: Partial<AgentConfig>): {
  tools: ToolSet;
  counters: ToolCallCounters;
  cache: ToolResultCache;
} {
  const counters: ToolCallCounters = { total: 0, perIteration: 0 };
  const cache: ToolResultCache = new Map();
  return {
    tools: buildTools({ ...config } as AgentConfig, 0, cache, counters),
    counters,
    cache,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildTools: provider-executed tools (no local execute)', () => {
  it('registers provider tools unchanged when no permission policy is set', () => {
    const { tools } = build({ tools: { web: providerTool('webSearch') } });
    expect(tools['web']).toBeDefined();
  });

  it('omits provider tools entirely under mode deny-all (fail closed)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const permissions: PermissionConfig = { mode: 'deny-all' };
    const { tools } = build({
      tools: { web: providerTool('webSearch'), local: locallyExecutedTool() },
      permissions,
    });
    // The provider tool must not reach the model at all...
    expect(tools['web']).toBeUndefined();
    // ...while the locally-executed tool in the same set is untouched.
    expect(tools['local']).toBeDefined();
    expect(tools['local']!.execute).toBeDefined();
    // The omission is loud, not silent.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('web');
  });

  it('omits provider tools under mode ask without calling onPermissionRequest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 'ask' cannot prompt per provider-side call, and firing the handler
    // once per step with fabricated empty args would be worse. Fail closed.
    const onPermissionRequest = vi.fn().mockResolvedValue(true);
    const permissions: PermissionConfig = { mode: 'ask', onPermissionRequest };
    const { tools } = build({
      tools: { web: providerTool('webSearch') },
      permissions,
    });
    expect(tools['web']).toBeUndefined();
    expect(onPermissionRequest).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('registers provider tools under mode accept-all', () => {
    const permissions: PermissionConfig = { mode: 'accept-all' };
    const { tools } = build({
      tools: { web: providerTool('webSearch') },
      permissions,
    });
    expect(tools['web']).toBeDefined();
  });

  it('registers provider tools with an explicit always override in ask mode', () => {
    const permissions: PermissionConfig = {
      mode: 'ask',
      tools: { 'google__webSearch': 'always' },
    };
    const { tools } = build({
      tools: { 'google__webSearch': providerTool('webSearch') },
      permissions,
    });
    expect(tools['google__webSearch']).toBeDefined();
  });

  it('registers provider tools with an always override even under deny-all', () => {
    const permissions: PermissionConfig = {
      mode: 'deny-all',
      tools: { 'google__webSearch': 'always' },
    };
    const { tools } = build({
      tools: { 'google__webSearch': providerTool('webSearch') },
      permissions,
    });
    expect(tools['google__webSearch']).toBeDefined();
  });

  it('omits provider tools with a never override even under accept-all', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const permissions: PermissionConfig = {
      mode: 'accept-all',
      tools: { 'openai__applyPatch': 'never' },
    };
    const { tools } = build({
      tools: { 'openai__applyPatch': providerTool('applyPatch') },
      permissions,
    });
    expect(tools['openai__applyPatch']).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not touch tool-call counters at registration', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { counters } = build({
      tools: { web: providerTool('webSearch') },
      permissions: { mode: 'deny-all' },
    });
    expect(counters.total).toBe(0);
    expect(counters.perIteration).toBe(0);
  });
});

describe('buildTools: locally-executed tools keep the per-call wrapper', () => {
  it('still denies denied calls through the wrapped execute', async () => {
    const { tools, cache, counters } = build({
      tools: { local: locallyExecutedTool() },
      permissions: { mode: 'deny-all' },
    });
    const wrapped = tools['local'] as {
      execute: (args: unknown, options: unknown) => Promise<string>;
    };
    expect(wrapped.execute).toBeDefined();
    const out = await wrapped.execute({}, { toolCallId: 'call-1' });
    expect(out).toContain('Permission denied');
    expect(cache.get('call-1')?.blocked).toBe(true);
    // A denied call still consumed a limit slot (count before check).
    expect(counters.total).toBe(1);
  });

  it('wraps skill tools the same as before (they always have execute)', async () => {
    const store = new InMemorySkillStore();
    const { tools } = build({
      skills: store,
      allowSkillInstall: true,
    });
    expect(Object.keys(tools).length).toBeGreaterThan(0);
    for (const t of Object.values(tools)) {
      expect(t.execute).toBeDefined();
    }
  });
});
