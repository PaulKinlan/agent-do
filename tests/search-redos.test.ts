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

    it('handles a pathological regex pattern as literal text without compiling it', async () => {
      await store.write('a', 'safe.txt', 'just some content');
      // Per Copilot's #63 review: a wall-clock timeout is flaky on busy
      // CI. Assert the *intended* property instead — literal mode
      // never builds a RegExp, so the pattern is a pure substring
      // lookup and no backtracking can occur. We prove this by writing
      // file content that contains the pattern verbatim: in literal
      // mode it should match; if anyone accidentally switched the
      // default back to regex, `(a+)+$` wouldn't match the literal
      // string `(a+)+$` and this assertion would fail loudly.
      await store.write('a', 'pattern.txt', '(a+)+$');
      const r = await store.search('a', '(a+)+$');
      expect(r).toHaveLength(1);
      expect(r[0]!.line).toBe('(a+)+$');
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
    // CodeQL would flag `aaaa…!` + `(a+)+$` as a catastrophic-input
    // test fixture. That's the whole point — we *want* to prove the
    // guard rejects the pattern before the engine sees the input. The
    // shorter content below is still pathologically shaped for any
    // future regression where the guard is dropped, without being
    // flagged as an accidental live ReDoS vector.
    await store.write('a', 'note.txt', 'aaaaaaaaa!');
    await expect(
      store.search('a', '(a+)+$', undefined, { regex: true }),
    ).rejects.toThrow(/nested quantifier|catastrophic backtracking/i);
  });

  it('rejects more variations of nested quantifiers', async () => {
    const cases = ['(x*)*', '(ab+)*', '(.+)+', '(a*)+'];
    for (const pat of cases) {
      await expect(
        store.search('a', pat, undefined, { regex: true }),
      ).rejects.toThrow(/nested quantifier|catastrophic backtracking/i);
    }
  });

  it('rejects alternation-with-trailing-quantifier shapes (Codex #63 P1)', async () => {
    // Codex review on PR #63: `(a|a?)+` and similar alternation-overlap
    // patterns bypassed the original nested-quantifier-only check and
    // could still hang the loop on inputs like `aaaa…!`. The expanded
    // heuristic in src/stores/search-matcher.ts catches both shapes.
    const cases = ['(a|a?)+', '(a|aa)*', '(ab|a)+', '(x|x+)+'];
    for (const pat of cases) {
      await expect(
        store.search('a', pat, undefined, { regex: true }),
      ).rejects.toThrow(/catastrophic backtracking/i);
    }
  });

  it('rejects brace-quantifier variants (Codex #63 follow-up)', async () => {
    // The old regex-on-regex check only matched `+*?`, so `(a+){1,}`
    // and `(a|b){2,}` bypassed it. The character-level scan treats
    // `{n,m}` as a quantifier for the purposes of the nesting check.
    const cases = ['(a+){1,}', '(a+){2,5}', '(a|b){2,}', '(a*){1,3}'];
    for (const pat of cases) {
      await expect(
        store.search('a', pat, undefined, { regex: true }),
      ).rejects.toThrow(/catastrophic backtracking/i);
    }
  });

  it('rejects wrapped / deeply-nested danger shapes (Codex #63 follow-up)', async () => {
    // `[^)]*` in the old heuristic couldn't see through nested parens,
    // so `((a|a?))+$` slipped through. The stack-based scan propagates
    // the risk flag to outer groups so any wrapping depth still fires.
    const cases = ['((a|a?))+$', '(a|(a?))+$', '((a+))+', '(((a|b)))+'];
    for (const pat of cases) {
      await expect(
        store.search('a', pat, undefined, { regex: true }),
      ).rejects.toThrow(/catastrophic backtracking/i);
    }
  });

  it('accepts safe regex shapes that happen to contain groups or quantifiers', async () => {
    // Positive coverage: the scan should not reject plain groups,
    // plain alternations, single-level quantifiers, or any combination
    // that isn't a nested-repetition shape.
    await store.write('a', 'mix.txt', 'alpha 42\nbeta 7');
    const r1 = await store.search('a', '(alpha|beta)', undefined, { regex: true });
    expect(r1.length).toBeGreaterThan(0);
    const r2 = await store.search('a', '\\d+', undefined, { regex: true });
    expect(r2.length).toBeGreaterThan(0);
    const r3 = await store.search('a', '[a-z]+', undefined, { regex: true });
    expect(r3.length).toBeGreaterThan(0);
    // Paren-inside-class shouldn't confuse the scanner.
    const r4 = await store.search('a', '[()+*]', undefined, { regex: true });
    expect(Array.isArray(r4)).toBe(true);
  });

  it('accepts long literal patterns (no 256-char cap in literal mode)', async () => {
    // Codex + Copilot review on PR #63: the schema cap + store cap
    // were both regex-only, so a safe literal search of >256 chars
    // (pasted error signature etc.) should still work.
    const needle = 'q'.repeat(400);
    await store.write('a', 'note.txt', `prefix ${needle} suffix`);
    const r = await store.search('a', needle);
    expect(r).toHaveLength(1);
  });

  it('returns a clean error for invalid regex syntax (does not throw uncaught)', async () => {
    await expect(
      store.search('a', '[unterminated', undefined, { regex: true }),
    ).rejects.toThrow(/Invalid regex pattern/);
  });
});
