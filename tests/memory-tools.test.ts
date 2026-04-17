import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryTools } from '../src/tools/memory-tools.js';
import { InMemoryMemoryStore } from '../src/stores/in-memory.js';

describe('createMemoryTools', () => {
  let store: InMemoryMemoryStore;
  const agentId = 'memory-test';

  beforeEach(() => {
    store = new InMemoryMemoryStore();
  });

  async function exec(toolName: string, args: Record<string, unknown>) {
    const tools = createMemoryTools(store, agentId);
    const tool = tools[toolName];
    if (!tool || !tool.execute) throw new Error(`Tool ${toolName} not found`);
    return (tool.execute as Function)(args, {}) as Promise<string>;
  }

  it('exposes memory_* prefixed tools only', () => {
    const tools = createMemoryTools(store, agentId);
    expect(Object.keys(tools).sort()).toEqual([
      'memory_delete',
      'memory_list',
      'memory_read',
      'memory_search',
      'memory_write',
    ]);
  });

  it('writes and reads back from memory', async () => {
    await exec('memory_write', { path: 'note.md', content: 'remember this' });
    const out = await exec('memory_read', { path: 'note.md' });
    expect(out).toBe('remember this');
  });

  it('memory_list reports an empty memory on first use', async () => {
    const out = await exec('memory_list', {});
    expect(out).toMatch(/empty/i);
  });

  it('memory_search finds stored content', async () => {
    await exec('memory_write', { path: 'facts.md', content: 'capital of France is Paris' });
    const out = await exec('memory_search', { pattern: 'Paris' });
    expect(out).toContain('facts.md');
  });

  it('memory_delete removes a file', async () => {
    await exec('memory_write', { path: 'temp.md', content: 'bye' });
    await exec('memory_delete', { path: 'temp.md' });
    const read = await exec('memory_read', { path: 'temp.md' });
    expect(read).toMatch(/not found|Error/i);
  });

  it('scopes memory per agentId', async () => {
    const otherStore = store;
    const myTools = createMemoryTools(otherStore, 'agent-a');
    const theirTools = createMemoryTools(otherStore, 'agent-b');

    await (myTools.memory_write!.execute as Function)(
      { path: 'secret.txt', content: 'mine' }, {},
    );
    const theirRead = await (theirTools.memory_read!.execute as Function)(
      { path: 'secret.txt' }, {},
    );
    expect(theirRead).toMatch(/not found|Error/i);
  });
});
