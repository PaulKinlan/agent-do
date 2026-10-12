import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FilesystemMemoryStore } from '../src/stores/filesystem.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * `node:fs/promises` is a module namespace, so `vi.spyOn` on it is not allowed (ESM namespaces are frozen);
 * a partial mock that delegates to the real module is the supported way to observe the store's concurrency
 * STRUCTURALLY. `vi.hoisted` keeps the probe alive before the hoisted mock factory and the store import run.
 *
 * Why this exists (agent-do-j5j): the concurrency test used to time a 16-way `Promise.all` against a
 * sequential loop and assert the parallel batch was faster. That is a wall-clock assertion on a shared
 * machine: with a warm page cache the sequential awaits PIPELINE while all 16 parallel reads contend for
 * libuv's 4-thread pool, so the "parallel" batch can come out 2x SLOWER from a perfectly correct
 * implementation. It failed a landing gate at random (59 ms vs a 22.5 ms threshold) and the gate then treats
 * a cached FAIL as deterministic, so the only way through was deleting the record and hoping.
 * docs/speed.md names the pathology: a test asserting machine state turns someone else's change red for
 * reasons unrelated to their change.
 */
const fsProbe = vi.hoisted(() => ({
  inFlight: 0,
  peak: 0,
  /** When > 0, every read waits this many ms before touching the real fs. */
  delayMs: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    readFile: (async (...args: Parameters<typeof real.readFile>) => {
      fsProbe.inFlight += 1;
      if (fsProbe.inFlight > fsProbe.peak) fsProbe.peak = fsProbe.inFlight;
      try {
        // A fixed beat, not a latch: a serialising implementation then fails on the peak below instead of
        // hanging, and this stays bounded whatever the implementation does.
        if (fsProbe.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, fsProbe.delayMs));
        }
        return await real.readFile(...args);
      } finally {
        fsProbe.inFlight -= 1;
      }
    }) as unknown as typeof real.readFile,
  };
});

describe('FilesystemMemoryStore', () => {
  let store: FilesystemMemoryStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-do-test-'));
    store = new FilesystemMemoryStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('write and read', () => {
    it('writes and reads a file', async () => {
      await store.write('agent-1', 'hello.txt', 'Hello World');
      const content = await store.read('agent-1', 'hello.txt');
      expect(content).toBe('Hello World');
    });

    it('creates parent directories automatically', async () => {
      await store.write('agent-1', 'a/b/c/deep.txt', 'deep');
      expect(fs.existsSync(path.join(tmpDir, 'agent-1', 'a', 'b', 'c', 'deep.txt'))).toBe(true);
    });

    it('persists to actual filesystem', async () => {
      await store.write('agent-1', 'real.txt', 'on disk');
      const onDisk = fs.readFileSync(path.join(tmpDir, 'agent-1', 'real.txt'), 'utf-8');
      expect(onDisk).toBe('on disk');
    });

    it('isolates agents', async () => {
      await store.write('a1', 'file.txt', 'agent 1');
      await store.write('a2', 'file.txt', 'agent 2');
      expect(await store.read('a1', 'file.txt')).toBe('agent 1');
      expect(await store.read('a2', 'file.txt')).toBe('agent 2');
    });

    it('throws for missing files', async () => {
      await expect(store.read('agent-1', 'nope.txt')).rejects.toThrow('File not found');
    });

    it('blocks path traversal', async () => {
      await expect(store.write('agent-1', '../../etc/passwd', 'bad')).rejects.toThrow('Path traversal');
    });
  });

  describe('append', () => {
    it('appends to existing file', async () => {
      await store.write('agent-1', 'log.txt', 'line1\n');
      await store.append('agent-1', 'log.txt', 'line2\n');
      expect(await store.read('agent-1', 'log.txt')).toBe('line1\nline2\n');
    });

    it('creates file if missing', async () => {
      await store.append('agent-1', 'new.txt', 'first');
      expect(await store.read('agent-1', 'new.txt')).toBe('first');
    });
  });

  describe('delete', () => {
    it('deletes a file', async () => {
      await store.write('agent-1', 'temp.txt', 'data');
      await store.delete('agent-1', 'temp.txt');
      expect(await store.exists('agent-1', 'temp.txt')).toBe(false);
    });

    it('does not throw for missing files', async () => {
      await expect(store.delete('agent-1', 'nope.txt')).resolves.toBeUndefined();
    });
  });

  describe('list', () => {
    it('lists files and directories', async () => {
      await store.write('agent-1', 'a.txt', 'a');
      await store.write('agent-1', 'b.txt', 'b');
      await store.mkdir('agent-1', 'subdir');

      const entries = await store.list('agent-1');
      const names = entries.map(e => e.name).sort();
      expect(names).toContain('a.txt');
      expect(names).toContain('b.txt');
      expect(names).toContain('subdir');
    });

    it('returns file sizes', async () => {
      await store.write('agent-1', 'sized.txt', 'hello');
      const entries = await store.list('agent-1');
      const file = entries.find(e => e.name === 'sized.txt');
      expect(file?.size).toBe(5);
    });

    it('returns empty for nonexistent directory', async () => {
      expect(await store.list('agent-1', 'nope')).toEqual([]);
    });
  });

  describe('mkdir', () => {
    it('creates nested directories', async () => {
      await store.mkdir('agent-1', 'a/b/c');
      expect(fs.existsSync(path.join(tmpDir, 'agent-1', 'a', 'b', 'c'))).toBe(true);
    });
  });

  describe('exists', () => {
    it('returns true for files', async () => {
      await store.write('agent-1', 'file.txt', 'data');
      expect(await store.exists('agent-1', 'file.txt')).toBe(true);
    });

    it('returns true for directories', async () => {
      await store.mkdir('agent-1', 'dir');
      expect(await store.exists('agent-1', 'dir')).toBe(true);
    });

    it('returns false for missing paths', async () => {
      expect(await store.exists('agent-1', 'nope')).toBe(false);
    });
  });

  describe('search', () => {
    it('finds matching lines', async () => {
      await store.write('agent-1', 'notes.txt', 'hello world\ngoodbye world');
      await store.write('agent-1', 'other.txt', 'no match');

      const results = await store.search('agent-1', 'hello');
      expect(results.length).toBe(1);
      expect(results[0]!.line).toContain('hello world');
    });

    it('searches recursively', async () => {
      await store.write('agent-1', 'a/deep.txt', 'findme here');
      const results = await store.search('agent-1', 'findme');
      expect(results.length).toBe(1);
      expect(results[0]!.path).toContain('deep.txt');
    });
  });

  describe('readOnly mode', () => {
    it('blocks write operations', async () => {
      const roStore = new FilesystemMemoryStore(tmpDir, { readOnly: true });
      await expect(roStore.write('agent-1', 'file.txt', 'data')).rejects.toThrow('read-only');
    });

    it('blocks append operations', async () => {
      const roStore = new FilesystemMemoryStore(tmpDir, { readOnly: true });
      await expect(roStore.append('agent-1', 'file.txt', 'data')).rejects.toThrow('read-only');
    });

    it('blocks delete operations', async () => {
      const roStore = new FilesystemMemoryStore(tmpDir, { readOnly: true });
      await expect(roStore.delete('agent-1', 'file.txt')).rejects.toThrow('read-only');
    });

    it('blocks mkdir operations', async () => {
      const roStore = new FilesystemMemoryStore(tmpDir, { readOnly: true });
      await expect(roStore.mkdir('agent-1', 'newdir')).rejects.toThrow('read-only');
    });

    it('allows read operations', async () => {
      // Write with the normal store first
      await store.write('agent-1', 'readable.txt', 'can read this');
      const roStore = new FilesystemMemoryStore(tmpDir, { readOnly: true });
      const content = await roStore.read('agent-1', 'readable.txt');
      expect(content).toBe('can read this');
    });

    it('allows list operations', async () => {
      await store.write('agent-1', 'listed.txt', 'data');
      const roStore = new FilesystemMemoryStore(tmpDir, { readOnly: true });
      const entries = await roStore.list('agent-1');
      expect(entries.length).toBeGreaterThan(0);
    });
  });

  describe('onBeforeWrite callback', () => {
    it('blocks writes when callback returns false', async () => {
      const guardedStore = new FilesystemMemoryStore(tmpDir, {
        onBeforeWrite: async () => false,
      });
      await expect(guardedStore.write('agent-1', 'blocked.txt', 'nope')).rejects.toThrow('blocked by onBeforeWrite');
    });

    it('allows writes when callback returns true', async () => {
      const guardedStore = new FilesystemMemoryStore(tmpDir, {
        onBeforeWrite: async () => true,
      });
      await guardedStore.write('agent-1', 'allowed.txt', 'yes');
      expect(await guardedStore.read('agent-1', 'allowed.txt')).toBe('yes');
    });

    it('receives correct arguments', async () => {
      const calls: Array<{ agentId: string; path: string; op: string }> = [];
      const guardedStore = new FilesystemMemoryStore(tmpDir, {
        onBeforeWrite: async (agentId, filePath, operation) => {
          calls.push({ agentId, path: filePath, op: operation });
          return true;
        },
      });
      await guardedStore.write('test-agent', 'notes/hello.md', 'hi');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.agentId).toBe('test-agent');
      expect(calls[0]!.path).toBe('notes/hello.md');
      expect(calls[0]!.op).toBe('write');
    });

    it('is called for delete and mkdir too', async () => {
      const ops: string[] = [];
      const guardedStore = new FilesystemMemoryStore(tmpDir, {
        onBeforeWrite: async (_a, _p, op) => { ops.push(op); return true; },
      });
      await guardedStore.write('agent-1', 'temp.txt', 'data');
      await guardedStore.mkdir('agent-1', 'newdir');
      await guardedStore.delete('agent-1', 'temp.txt');
      expect(ops).toEqual(['write', 'mkdir', 'delete']);
    });
  });

  describe('idempotency for nested-under-file paths (Codex #61 P2)', () => {
    // When the model hallucinates paths like `"readme.md/child"` the
    // pre-migration code used `fs.existsSync` first and silently noop'd.
    // The async migration started surfacing ENOTDIR from unlink/stat.
    // Restore the original behaviour: delete is idempotent, exists
    // returns false.
    it('delete() is a no-op when an ancestor is a file (ENOTDIR)', async () => {
      await store.write('agent-1', 'readme.md', 'top');
      await expect(
        store.delete('agent-1', 'readme.md/child.txt'),
      ).resolves.toBeUndefined();
    });

    it('exists() returns false when an ancestor is a file (ENOTDIR)', async () => {
      await store.write('agent-1', 'readme.md', 'top');
      expect(await store.exists('agent-1', 'readme.md/child.txt')).toBe(false);
    });

    it('read() normalises ENOTDIR to "File not found" (Codex #61 follow-up)', async () => {
      await store.write('agent-1', 'readme.md', 'top');
      await expect(
        store.read('agent-1', 'readme.md/child.txt'),
      ).rejects.toThrow(/File not found/);
    });

    it('list() returns [] when an ancestor is a file (Codex #61 follow-up)', async () => {
      await store.write('agent-1', 'readme.md', 'top');
      expect(await store.list('agent-1', 'readme.md')).toEqual([]);
    });

    it('search() returns [] when an ancestor is a file (Codex #61 follow-up)', async () => {
      await store.write('agent-1', 'readme.md', 'findme here');
      expect(await store.search('agent-1', 'findme', 'readme.md')).toEqual([]);
    });
  });

  describe('async behaviour (#25)', () => {
    it('keeps the read promise pending across a setImmediate tick', async () => {
      // Per Copilot's review: the original assertion just checked that a
      // setImmediate fired, which a fast sync-then-resolve implementation
      // could also satisfy. The stricter test tracks whether the read
      // promise itself is still pending when the immediate runs. With
      // `fs.readFileSync` the promise resolves synchronously on creation,
      // so `settled` would be true on the next tick. With `fsp.readFile`
      // the I/O is dispatched to the threadpool and `settled` stays false.
      const big = 'x'.repeat(64 * 1024);
      await store.write('agent-1', 'big.bin', big);

      let settled = false;
      const readPromise = store.read('agent-1', 'big.bin');
      readPromise.finally(() => {
        settled = true;
      });

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      await readPromise;
      expect(settled).toBe(true);
    });

    it('runs concurrent reads in parallel rather than serialising them', async () => {
      // Per Copilot's review: a pure correctness check (results match input) would also pass if reads were
      // silently serialised, so the concurrency itself has to be observed. It is observed STRUCTURALLY
      // here: give the fs layer a fixed beat, issue N reads, and count the PEAK number the implementation
      // had in flight at once. A serialising implementation can only ever reach 1, because it waits for
      // each read before issuing the next - so the peak IS the property, with no wall clock, no seqMs
      // floor and no ratio. The old timing version is explained in the fsProbe comment (agent-do-j5j).
      const N = 16;
      const big = 'y'.repeat(128 * 1024);
      for (let i = 0; i < N; i++) {
        await store.write('agent-1', `f${i}.txt`, big);
      }

      fsProbe.peak = 0;
      fsProbe.delayMs = 50;
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) => store.read('agent-1', `f${i}.txt`)),
      );
      const observedPeak = fsProbe.peak;
      fsProbe.delayMs = 0;

      expect(results).toHaveLength(N);
      expect(results.every((content) => content === big)).toBe(true);
      expect(observedPeak, 'peak reads in flight at once').toBeGreaterThan(1);
    });
  });
});
