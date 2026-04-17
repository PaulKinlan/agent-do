import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FilesystemMemoryStore } from '../src/stores/filesystem.js';
import { InMemoryMemoryStore } from '../src/stores/in-memory.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Tests for issue #21 — ReDoS protection on grep_file / store.search.
 *
 * Both store implementations now default to literal substring search
 * (no regex compilation, no backtracking surface). Regex mode is
 * opt-in via `{ regex: true }` and goes through length + nested-
 * quantifier checks before being compiled.
 */

describe('store.search literal mode (default)', () => {
  describe('FilesystemMemoryStore', () => {
    let store: FilesystemMemoryStore;
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-do-redos-'));
      store = new FilesystemMemoryStore(tmpDir);
    });
    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('matches literal substrings (case-insensitive) by default', async () => {
      await store.write('a', 'note.txt', 'Hello World\nGoodbye Moon');
      const r = await store.search('a', 'hello');
      expect(r).toHaveLength(1);
      expect(r[0]!.line).toContain('Hello World');
    });

    it('does not interpret regex metacharacters in literal mode', async () => {
      await store.write('a', 'note.txt', 'a.b\naxb\na+b\n');
      // In literal mode `a.b` matches the dot literally, not "any char".
      const r = await store.search('a', 'a.b');
      expect(r).toHaveLength(1);
      expect(r[0]!.line).toBe('a.b');
    });

    it('handles a pathological regex pattern as literal text without hanging', async () => {
      await store.write('a', 'safe.txt', 'just some content');
      // The classic catastrophic-backtracking pattern. In literal mode
      // it's just a substring lookup — no backtracking, no hang.
      const start = Date.now();
      const r = await store.search('a', '(a+)+$');
      expect(Date.now() - start).toBeLessThan(100);
      expect(r).toHaveLength(0);
    });
  });

  describe('InMemoryMemoryStore', () => {
    let store: InMemoryMemoryStore;
    beforeEach(() => {
      store = new InMemoryMemoryStore();
    });

    it('matches literal substrings (case-insensitive) by default', async () => {
      await store.write('a', 'note.txt', 'Hello World');
      const r = await store.search('a', 'hello');
      expect(r).toHaveLength(1);
    });
  });
});

describe('store.search regex mode (opt-in)', () => {
  let store: FilesystemMemoryStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-do-redos-'));
    store = new FilesystemMemoryStore(tmpDir);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('honours regex semantics when explicitly enabled', async () => {
    await store.write('a', 'note.txt', 'foo123\nbar456\n');
    const r = await store.search('a', '^[a-z]+\\d+$', undefined, { regex: true });
    expect(r).toHaveLength(2);
  });

  it('rejects patterns longer than the cap', async () => {
    await store.write('a', 'note.txt', 'content');
    const longPattern = 'a'.repeat(300);
    await expect(
      store.search('a', longPattern, undefined, { regex: true }),
    ).rejects.toThrow(/too long/);
  });

  it('rejects nested-quantifier patterns before compiling them', async () => {
    await store.write('a', 'note.txt', 'aaaaaaaaaaaaaaaaaaaaaaaaaa!');
    // The canonical catastrophic pattern. Without the heuristic,
    // executing this against the matching line would hang the loop.
    const start = Date.now();
    await expect(
      store.search('a', '(a+)+$', undefined, { regex: true }),
    ).rejects.toThrow(/nested quantifier|catastrophic backtracking/i);
    // The reject should be near-instant — the safety check fires
    // before `new RegExp` is even called.
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('rejects more variations of nested quantifiers', async () => {
    const cases = ['(x*)*', '(ab+)*', '(.+)+', '(a*)+'];
    for (const pat of cases) {
      await expect(
        store.search('a', pat, undefined, { regex: true }),
      ).rejects.toThrow(/nested quantifier/);
    }
  });

  it('returns a clean error for invalid regex syntax (does not throw uncaught)', async () => {
    await expect(
      store.search('a', '[unterminated', undefined, { regex: true }),
    ).rejects.toThrow(/Invalid regex pattern/);
  });
});
