import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemMemoryStore } from '../src/stores/filesystem.js';
import { acquireFileLock, withFileLock } from '../src/stores/file-lock.js';
import type { FileLockOptions, LockAdapter, LockHandle } from '../src/types.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'file-lock-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ── acquireFileLock / withFileLock ──────────────────────────────────────

describe('acquireFileLock', () => {
  it('acquires and releases cleanly', async () => {
    const handle = await acquireFileLock(join(dir, 'a.md'), 'agent1', join(dir, '.locks'));
    await handle.release();
    // Releasing drops every lock file for agent1.
    const lockDir = join(dir, '.locks', 'agent1');
    const files = await readdir(lockDir).catch(() => [] as string[]);
    expect(files.filter((f) => f.endsWith('.lock'))).toEqual([]);
  });

  it('serialises concurrent holders of the same key (mutual exclusion)', async () => {
    // Two acquires for the SAME canonical path must not overlap. We detect
    // overlap by holding the first lock until a flag flips, then asserting
    // the second only entered after the flag was set.
    const key = join(dir, 'shared.md');
    let heldSecond = false;
    let overlapDetected = false;

    const h1 = await acquireFileLock(key, 'agent1', join(dir, '.locks'));
    const p2 = (async () => {
      await acquireFileLock(key, 'agent1', join(dir, '.locks'), {
        retry: { count: 50, minDelayMs: 5, maxDelayMs: 20 },
      }).then(async (h) => {
        heldSecond = true;
        await h.release();
      });
    })();

    // Give p2 a chance to (incorrectly) acquire while h1 still holds.
    await new Promise((r) => setTimeout(r, 30));
    if (heldSecond) overlapDetected = true;

    await h1.release();
    await p2;
    expect(overlapDetected).toBe(false);
  });

  it('reclaims a stale lock past staleMs', async () => {
    const key = join(dir, 'stale.md');
    // Acquire then backdate its mtime to before the threshold.
    const h1 = await acquireFileLock(key, 'agent1', join(dir, '.locks'));
    const lockDir = join(dir, '.locks', 'agent1');
    const old = new Date(Date.now() - 120_000);
    const files = await readdir(lockDir);
    const lf = join(lockDir, files[0]!);
    await utimes(lf, old, old);
    await h1.release(); // best-effort; file may persist if backdated after open

    // A fresh acquire with staleMs=1000 should succeed despite the leftover lock.
    const h2 = await acquireFileLock(key, 'agent1', join(dir, '.locks'), {
      staleMs: 1000,
      retry: { count: 2, minDelayMs: 1, maxDelayMs: 2 },
    });
    expect(h2).toBeDefined();
    await h2.release();
  });

  it('throws after exhausting retries when the lock is held and fresh', async () => {
    const key = join(dir, 'held.md');
    const h1 = await acquireFileLock(key, 'agent1', join(dir, '.locks'));
    await expect(
      acquireFileLock(key, 'agent1', join(dir, '.locks'), {
        staleMs: 60_000,
        retry: { count: 3, minDelayMs: 1, maxDelayMs: 2 },
      }),
    ).rejects.toThrow(/Could not acquire file lock/);
    await h1.release();
  });

  it('delegates to a provided adapter', async () => {
    const calls: string[] = [];
    const adapter: LockAdapter = {
      async acquire(_lockFile, _opts) {
        calls.push('acquire');
        return { async release() { calls.push('release'); } };
      },
    };
    const opts: FileLockOptions = { adapter };
    await withFileLock(join(dir, 'x.md'), 'agent1', join(dir, '.locks'), opts, async () => {
      calls.push('body');
    });
    expect(calls).toEqual(['acquire', 'body', 'release']);
  });
});

describe('withFileLock', () => {
  it('releases the lock even when the critical section throws', async () => {
    const key = join(dir, 'throwy.md');
    await expect(
      withFileLock(key, 'agent1', join(dir, '.locks'), {}, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // Lock must be gone — a subsequent acquire should succeed immediately.
    const h = await acquireFileLock(key, 'agent1', join(dir, '.locks'), {
      retry: { count: 2, minDelayMs: 1, maxDelayMs: 2 },
    });
    await h.release();
  });

  it('returns the critical section result', async () => {
    const out = await withFileLock(
      join(dir, 'r.md'), 'agent1', join(dir, '.locks'), {},
      async () => 42,
    );
    expect(out).toBe(42);
  });
});

// ── FilesystemMemoryStore integration ───────────────────────────────────

describe('FilesystemMemoryStore — lock option', () => {
  it('is byte-identical to the unlocked behaviour when `lock` is undefined', async () => {
    const store = new FilesystemMemoryStore(join(dir, 'plain'));
    await store.write('agent1', 'note.md', 'hello');
    expect(await store.read('agent1', 'note.md')).toBe('hello');
    // No .locks dir is created when the option is off.
    await expect(readdir(join(dir, 'plain'))).resolves.not.toContain('.locks');
  });

  it('serialises concurrent writes to the same file', async () => {
    const store = new FilesystemMemoryStore(join(dir, 'locked'), {
      lock: { staleMs: 60_000, retry: { count: 100, minDelayMs: 5, maxDelayMs: 20 } },
    });
    // Two appends racing without a lock would interleave / lose one; with
    // the lock they serialise and both lines land.
    await Promise.all([
      store.append('agent1', 'log.md', 'line-a\n'),
      store.append('agent1', 'log.md', 'line-b\n'),
    ]);
    const content = await store.read('agent1', 'log.md');
    const a = (content.match(/line-a/g) || []).length;
    const b = (content.match(/line-b/g) || []).length;
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it('makes writes atomic — readers only ever see complete values', async () => {
    // The temp+rename complement to locking: read() takes no lock, so it
    // must see either the old or the new content, never a torn write.
    // We run many writes while reading concurrently and assert every read
    // returns a *complete* well-formed value (old or one of the new ones),
    // never a truncated/partial body.
    const store = new FilesystemMemoryStore(join(dir, 'atomic'), {
      lock: { retry: { count: 50, minDelayMs: 1, maxDelayMs: 4 } },
    });
    const MARKER = 'X'.repeat(4000);
    await store.write('agent1', 'snap.md', 'OLD');

    let writesDone = false;
    const writer = (async () => {
      for (let i = 0; i < 25; i++) {
        await store.write('agent1', 'snap.md', `NEW-${i}-${MARKER}`);
      }
      writesDone = true;
    })();

    const valid = (c: string): boolean => c === 'OLD' || /^NEW-\d+-X{4000}$/.test(c);
    const reads: Promise<void>[] = [];
    for (let r = 0; r < 25; r++) {
      reads.push((async () => {
        // Stagger reads slightly so some land mid-write.
        await new Promise((s) => setTimeout(s, r));
        const c = await store.read('agent1', 'snap.md').catch(() => null);
        // A read either fails (rare, mid-rename) or returns a complete value.
        // It must NEVER return a partial body (old/new marker without full X run).
        if (c !== null) expect(valid(c)).toBe(true);
      })());
    }

    await writer;
    await Promise.all(reads);
    expect(writesDone).toBe(true);
    // Final state is exactly the last write — no corruption.
    expect(await store.read('agent1', 'snap.md')).toBe(`NEW-24-${MARKER}`);
  });

  it('keeps lock files invisible to per-agent list()', async () => {
    const store = new FilesystemMemoryStore(join(dir, 'hidden'), { lock: {} });
    await store.write('agent1', 'data.md', 'x');
    const entries = await store.list('agent1');
    const names = entries.map((e) => e.name);
    expect(names).toContain('data.md');
    expect(names.some((n) => n.endsWith('.lock'))).toBe(false);
    expect(names).not.toContain('.locks');
  });

  it('respects readOnly even when lock is set', async () => {
    const store = new FilesystemMemoryStore(join(dir, 'ro'), {
      readOnly: true,
      lock: {},
    });
    await expect(store.write('agent1', 'x.md', 'y')).rejects.toThrow(/read-only/);
  });
});

// ── helpers ────────────────────────────────────────────────────────────
