import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createSavedAgent, listSavedAgents, loadSavedAgent } from '../src/cli/agents.js';
import type { ParsedArgs } from '../src/cli/args.js';

const TEST_DIR = path.join('.agent-do-test-' + Date.now());
const AGENTS_DIR = path.join(TEST_DIR, 'agents');

// Override the agents dir for testing
const originalCwd = process.cwd();

function makeArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command: 'create',
    provider: 'anthropic',
    systemPrompt: 'You are a test agent.',
    memoryDir: TEST_DIR,
    readOnly: false,
    maxIterations: 20,
    noTools: false,
    verbose: false,
    json: false,
    help: false,
    output: 'console',
    concurrency: 1,
    ...overrides,
  };
}

describe('saved agents', () => {
  beforeEach(async () => {
    await fs.promises.mkdir(AGENTS_DIR, { recursive: true });
  });

  afterEach(async () => {
    await fs.promises.rm(TEST_DIR, { recursive: true, force: true });
  });

  it('loadSavedAgent returns null for nonexistent agent', async () => {
    const result = await loadSavedAgent('nonexistent');
    expect(result).toBeNull();
  });

  it('loadSavedAgent reads a valid config', async () => {
    const config = {
      name: 'test-agent',
      provider: 'google',
      model: 'gemini-2.5-flash',
      systemPrompt: 'Be helpful.',
      memoryDir: '.data',
      readOnly: false,
      maxIterations: 10,
      noTools: false,
      createdAt: '2026-04-13T00:00:00Z',
    };
    const agentDir = path.join('.agent-do', 'agents');
    await fs.promises.mkdir(agentDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(agentDir, 'test-agent.json'),
      JSON.stringify(config),
    );

    const loaded = await loadSavedAgent('test-agent');
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe('test-agent');
    expect(loaded!.provider).toBe('google');
    expect(loaded!.model).toBe('gemini-2.5-flash');

    // Cleanup
    await fs.promises.rm(path.join('.agent-do', 'agents', 'test-agent.json'));
  });

  it('loadSavedAgent returns null for invalid JSON', async () => {
    await fs.promises.mkdir(path.join('.agent-do', 'agents'), { recursive: true });
    await fs.promises.writeFile(
      path.join('.agent-do', 'agents', 'bad.json'),
      'not json{{{',
    );

    const loaded = await loadSavedAgent('bad');
    expect(loaded).toBeNull();

    // Cleanup
    await fs.promises.rm(path.join('.agent-do', 'agents', 'bad.json'));
  });
});
