import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadSavedAgent } from '../src/cli/agents.js';

const originalCwd = process.cwd();
let testDir: string;

describe('saved agents', () => {
  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-do-test-'));
    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.promises.rm(testDir, { recursive: true, force: true });
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
  });

  it('loadSavedAgent returns null for invalid JSON', async () => {
    const agentDir = path.join('.agent-do', 'agents');
    await fs.promises.mkdir(agentDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(agentDir, 'bad.json'),
      'not json{{{',
    );

    const loaded = await loadSavedAgent('bad');
    expect(loaded).toBeNull();
  });

  it('rejects invalid agent names', async () => {
    await expect(loadSavedAgent('my agent')).rejects.toThrow('Invalid agent name');
    await expect(loadSavedAgent('../../etc')).rejects.toThrow('Invalid agent name');
    await expect(loadSavedAgent('')).rejects.toThrow('Invalid agent name');
  });

  it('accepts valid agent names', async () => {
    // Should not throw, just return null (not found)
    const result = await loadSavedAgent('my-agent_v2');
    expect(result).toBeNull();
  });

  it('loadSavedAgent walks up the directory tree to find agents', async () => {
    // Create agent in the parent (testDir), then chdir into a nested child.
    const parentAgents = path.join(testDir, '.agent-do', 'agents');
    await fs.promises.mkdir(parentAgents, { recursive: true });
    await fs.promises.writeFile(
      path.join(parentAgents, 'reviewer.json'),
      JSON.stringify({
        name: 'reviewer',
        provider: 'anthropic',
        systemPrompt: 'Review code',
        memoryDir: '.data',
        readOnly: false,
        maxIterations: 10,
        noTools: false,
        createdAt: '2026-04-17T00:00:00Z',
      }),
    );

    const nested = path.join(testDir, 'a', 'b', 'c');
    await fs.promises.mkdir(nested, { recursive: true });
    process.chdir(nested);

    const loaded = await loadSavedAgent('reviewer');
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe('reviewer');
    expect(loaded!.provider).toBe('anthropic');
  });

  it('loadSavedAgent prefers the closest ancestor when names collide', async () => {
    // Parent defines "shared" one way, child defines it differently.
    const parentAgents = path.join(testDir, '.agent-do', 'agents');
    await fs.promises.mkdir(parentAgents, { recursive: true });
    await fs.promises.writeFile(
      path.join(parentAgents, 'shared.json'),
      JSON.stringify({ name: 'shared', provider: 'anthropic', systemPrompt: 'parent version', memoryDir: '.data', readOnly: false, maxIterations: 10, noTools: false, createdAt: '' }),
    );

    const child = path.join(testDir, 'child');
    const childAgents = path.join(child, '.agent-do', 'agents');
    await fs.promises.mkdir(childAgents, { recursive: true });
    await fs.promises.writeFile(
      path.join(childAgents, 'shared.json'),
      JSON.stringify({ name: 'shared', provider: 'google', systemPrompt: 'child version', memoryDir: '.data', readOnly: false, maxIterations: 10, noTools: false, createdAt: '' }),
    );

    process.chdir(child);
    const loaded = await loadSavedAgent('shared');
    expect(loaded!.provider).toBe('google');
    expect(loaded!.systemPrompt).toBe('child version');
  });
});
