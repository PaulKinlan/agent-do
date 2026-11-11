/**
 * Saved-agent resume: the operator's restricting flags must apply on top of the saved config
 * (agent-do-u3bv). The saved config GRANTS capabilities; `--no-tools` / `--read-only` take them
 * away. `--no-tools` used to be ignored entirely on this path (the code read `saved.noTools` only),
 * so `npx agent-do run <saved> --no-tools` still built full workspace tools, and `--read-only`
 * left the memory store writable while the workspace was restricted.
 *
 * runSavedAgent is mocked at its boundaries (model, agent loop, tool constructors, render) so these
 * tests pin the WIRING — which tools get constructed with which options — not the model behaviour.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';

const createdAgentConfigs: Array<Record<string, unknown>> = [];
const workspaceCalls: Array<{ dir: unknown; opts: Record<string, unknown> }> = [];
const memoryStoreCalls: Array<{ dir: unknown; opts: Record<string, unknown> }> = [];

vi.mock('../src/cli/resolve-model.js', () => ({
  resolveModel: vi.fn(async () => ({ modelId: 'mock-model' })),
}));
vi.mock('../src/cli/provider-tools.js', () => ({
  buildProviderTools: vi.fn(async () => ({})),
  expandProviderToolAllowNames: vi.fn(() => []),
}));
vi.mock('../src/agent.js', () => ({
  createAgent: vi.fn((cfg: Record<string, unknown>) => {
    createdAgentConfigs.push(cfg);
    return {
      stream: async function* () {
        yield { type: 'done', content: 'ok' };
      },
    };
  }),
}));
vi.mock('../src/tools/workspace-tools.js', () => ({
  createWorkspaceTools: vi.fn((dir: unknown, opts: Record<string, unknown>) => {
    workspaceCalls.push({ dir, opts });
    return { __workspace: true };
  }),
}));
vi.mock('../src/tools/memory-tools.js', () => ({
  createMemoryTools: vi.fn(() => ({ __memory: true })),
}));
vi.mock('../src/stores/filesystem.js', () => ({
  FilesystemMemoryStore: class {
    dir: unknown;
    opts: Record<string, unknown>;
    constructor(dir: unknown, opts: Record<string, unknown>) {
      this.dir = dir;
      this.opts = opts;
      memoryStoreCalls.push({ dir, opts });
    }
  },
}));
vi.mock('../src/cli/args.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readStdin: vi.fn(async () => undefined),
}));
vi.mock('../src/cli/render.js', () => ({
  renderEvent: vi.fn(() => ({ handled: true })),
  renderOptionsFromArgs: vi.fn(() => ({})),
}));

import { parseArgs } from '../src/cli/args.js';
import { runSavedAgent } from '../src/cli/script.js';
import type { ParsedArgs } from '../src/cli/args.js';

// A saved agent that enables everything — the restrictive flags are the only thing under test.
function writableSaved() {
  return {
    name: 'helper',
    provider: 'anthropic',
    systemPrompt: 'help',
    noTools: false,
    readOnly: false,
    withMemory: true,
    memoryDir: '/tmp/memory',
    maxIterations: 3,
  } as unknown as import('../src/cli/agents.js').SavedAgent;
}

function cliArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  const args = parseArgs(['run', 'helper', 'do the thing']);
  return { ...args, ...overrides };
}

describe('runSavedAgent — operator flags restrict a saved agent (agent-do-u3bv)', () => {
  beforeEach(() => {
    createdAgentConfigs.length = 0;
    workspaceCalls.length = 0;
    memoryStoreCalls.length = 0;
  });

  it('honours --no-tools on a saved agent that enables tools (the defect: it used to be ignored)', async () => {
    const args = cliArgs({ noTools: true });
    await runSavedAgent(writableSaved(), args);
    expect(workspaceCalls).toHaveLength(0);
    expect(memoryStoreCalls).toHaveLength(0);
    expect(createdAgentConfigs[0]?.['tools']).toBeUndefined();
  });

  it('honours --read-only on the workspace AND the memory store', async () => {
    const args = cliArgs({ readOnly: true });
    await runSavedAgent(writableSaved(), args);
    expect(workspaceCalls[0]?.opts?.readOnly).toBe(true);
    expect(memoryStoreCalls[0]?.opts?.readOnly).toBe(true);
  });

  it('still builds full tools when neither flag is passed', async () => {
    await runSavedAgent(writableSaved(), cliArgs());
    expect(workspaceCalls).toHaveLength(1);
    expect(workspaceCalls[0]?.opts?.readOnly).toBe(false);
    expect(memoryStoreCalls[0]?.opts?.readOnly).toBe(false);
    expect(createdAgentConfigs[0]?.['tools']).toBeDefined();
  });

  it('the prompt still reaches the agent (sanity: flags did not break the run)', async () => {
    const args = cliArgs();
    // readStdin is mocked to undefined; the task is the positional prompt.
    await runSavedAgent(writableSaved(), args);
    expect(createdAgentConfigs.length).toBe(1);
  });
});
