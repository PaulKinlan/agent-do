import { describe, it, expect } from 'vitest';
import { createAgent } from '../../src/agent.js';
import { createNoopSandbox } from '../../src/sandbox/connectors/noop.js';
import { createMockModel } from '../../src/testing/index.js';

/**
 * The `sandbox` field on AgentConfig is mainly a discovery point — the
 * loop doesn't auto-rewire tools when it's set (the user is expected to
 * wire memory/file/bash tools against the sandbox themselves, or use
 * createSandboxedToolset). This test asserts:
 *
 * 1. AgentConfig accepts `sandbox` without throwing.
 * 2. Agents constructed without `sandbox` still work (backward compat).
 */

describe('AgentConfig.sandbox', () => {
  it('accepts a SandboxApi instance', async () => {
    const agent = createAgent({
      id: 'sb-1',
      name: 'Sandbox Agent',
      model: createMockModel({ responses: [{ text: 'done.' }] }),
      sandbox: createNoopSandbox(),
    });
    const result = await agent.run('hello');
    expect(result).toBe('done.');
  });

  it('still works when sandbox is undefined (backward compatibility)', async () => {
    const agent = createAgent({
      id: 'sb-2',
      name: 'No Sandbox Agent',
      model: createMockModel({ responses: [{ text: 'done.' }] }),
    });
    const result = await agent.run('hello');
    expect(result).toBe('done.');
  });
});
