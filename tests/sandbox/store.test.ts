import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { SandboxBackedMemoryStore } from '../../src/stores/sandbox.js';
import { createHostSandbox } from '../../src/sandbox/connectors/host.js';

/**
 * SandboxBackedMemoryStore round-trip tests. The host sandbox is just a
 * `node:fs/promises` passthrough — perfect for confirming the bridge
 * preserves MemoryStore semantics (path scoping, idempotent delete,
 * search). Real isolation is covered by the connector tests; this file
 * is about the adapter layer.
 */

describe('SandboxBackedMemoryStore', () => {
  let root: string;
  let store: SandboxBackedMemoryStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'agent-do-sbms-'));
    store = new SandboxBackedMemoryStore(createHostSandbox(), root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes and reads under {root}/{agentId}/', async () => {
    await store.write('alice', 'a/b.txt', 'body');
    expect(await store.read('alice', 'a/b.txt')).toBe('body');
    // Tenant isolation: bob's view doesn't see alice's file.
    expect(await store.exists('bob', 'a/b.txt')).toBe(false);
  });

  it('list returns entries with type and size', async () => {
    await store.write('alice', 'one.txt', 'short');
    await store.write('alice', 'two.txt', 'longer');
    await store.mkdir('alice', 'sub');
    const entries = (await store.list('alice')).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    expect(entries.map((e) => ({ name: e.name, type: e.type }))).toEqual([
      { name: 'one.txt', type: 'file' },
      { name: 'sub', type: 'directory' },
      { name: 'two.txt', type: 'file' },
    ]);
    const one = entries.find((e) => e.name === 'one.txt')!;
    expect(one.size).toBe(5);
  });

  it('delete is idempotent', async () => {
    await store.delete('alice', 'never.txt');
    await store.write('alice', 'gone.txt', 'x');
    await store.delete('alice', 'gone.txt');
    expect(await store.exists('alice', 'gone.txt')).toBe(false);
  });

  it('append creates the file when missing and concatenates otherwise', async () => {
    await store.append('alice', 'log.txt', 'one\n');
    await store.append('alice', 'log.txt', 'two\n');
    expect(await store.read('alice', 'log.txt')).toBe('one\ntwo\n');
  });

  it('search finds matching lines (literal, case-insensitive)', async () => {
    await store.write('alice', 'a.txt', 'Hello\nWorld\n');
    await store.write('alice', 'sub/b.txt', 'hello again\n');
    const hits = await store.search('alice', 'hello');
    const paths = hits.map((h) => h.path).sort();
    expect(paths).toEqual(['a.txt', 'sub/b.txt']);
  });

  it('rejects path traversal that escapes the agent dir', async () => {
    await expect(
      store.write('alice', '../bob/secret.txt', 'oops'),
    ).rejects.toThrow(/Path traversal/);
  });

  it('readOnly blocks writes', async () => {
    const ro = new SandboxBackedMemoryStore(createHostSandbox(), root, {
      readOnly: true,
    });
    await expect(ro.write('alice', 'x.txt', 'no')).rejects.toThrow(/read-only/);
  });

  it('onBeforeWrite can deny operations', async () => {
    const guarded = new SandboxBackedMemoryStore(createHostSandbox(), root, {
      onBeforeWrite: async (_a, p) => !p.endsWith('.secret'),
    });
    await expect(guarded.write('alice', 'a.secret', 'no')).rejects.toThrow(
      /onBeforeWrite/,
    );
    await guarded.write('alice', 'a.txt', 'yes');
    expect(await guarded.read('alice', 'a.txt')).toBe('yes');
  });

  it('read surfaces non-ENOENT errors instead of masking as File not found', async () => {
    // Read failure due to a string-decoding error (binary content in
    // an encoding the sandbox can't handle) should NOT be mapped to
    // "File not found". Simulate with a stub sandbox that throws a
    // permission-style error.
    const failing = new SandboxBackedMemoryStore(
      {
        async readFile() {
          const e = new Error('EACCES: permission denied');
          (e as NodeJS.ErrnoException).code = 'EACCES';
          throw e;
        },
        // unused below
      } as unknown as Parameters<typeof Object.assign>[0] & import('../../src/sandbox/types.js').SandboxApi,
      root,
    );
    await expect(failing.read('alice', 'x.txt')).rejects.toThrow(/EACCES/);
  });
});
