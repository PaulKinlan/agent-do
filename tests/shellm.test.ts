import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseShellm, tryParseShellm, readShellmFile } from '../src/cli/shellm.js';

describe('parseShellm', () => {
  it('strips a shebang and uses the rest as the prompt', () => {
    const out = parseShellm('#!/usr/bin/env agent-do\nSummarize the git log.');
    expect(out.prompt).toBe('Summarize the git log.');
    expect(out.config).toEqual({});
  });

  it('handles a shebang-only file (empty prompt)', () => {
    const out = parseShellm('#!/usr/bin/env agent-do');
    expect(out.prompt).toBe('');
    expect(out.config).toEqual({});
  });

  it('parses YAML frontmatter into run config', () => {
    const out = parseShellm(
      '#!/usr/bin/env agent-do\n---\nprovider: google\nmodel: gemini-2.5-flash\nsystem: Be terse.\n---\nReview this code.',
    );
    expect(out.prompt).toBe('Review this code.');
    expect(out.config).toEqual({
      provider: 'google',
      model: 'gemini-2.5-flash',
      system: 'Be terse.',
    });
  });

  it('parses frontmatter without a shebang', () => {
    const out = parseShellm('---\nprovider: openai\n---\nHello.');
    expect(out.prompt).toBe('Hello.');
    expect(out.config.provider).toBe('openai');
  });

  it('treats a body with no frontmatter as a plain prompt', () => {
    const out = parseShellm('What is the capital of France?');
    expect(out.prompt).toBe('What is the capital of France?');
    expect(out.config).toEqual({});
  });

  it('keeps the prompt body when YAML is malformed', () => {
    const out = parseShellm(
      '---\nprovider: "unterminated\n---\nBody survives bad YAML.',
    );
    expect(out.prompt).toBe('Body survives bad YAML.');
    // Malformed YAML → no config extracted, but the body is never dropped.
    expect(out.config).toEqual({});
  });

  it('ignores unknown frontmatter keys and non-string values', () => {
    const out = parseShellm(
      '---\nprovider: anthropic\ncustom-field: whatever\ntools: 3\n---\nBody.',
    );
    expect(out.config).toEqual({ provider: 'anthropic' });
    expect(out.prompt).toBe('Body.');
  });

  it('reserves but captures the `agent` key', () => {
    const out = parseShellm('---\nagent: code-reviewer\n---\nReview this.');
    // Reserved in v1 (not wired) but parsed so a typo surfaces later.
    expect(out.config.agent).toBe('code-reviewer');
  });

  it('is ReDoS-safe on an adversarial frontmatter body', () => {
    // Hostile input that would blow up a naive /^---\n([\s\S]*?)\n---\n/
    // regex. The line-based parser must finish in O(n).
    const hostile = '---\n' + '\n '.repeat(50_000) + 'no closing fence';
    const start = Date.now();
    const out = parseShellm(hostile);
    const elapsed = Date.now() - start;
    expect(out.prompt.length).toBeGreaterThan(0); // fell back to body-only
    expect(out.config).toEqual({});
    expect(elapsed).toBeLessThan(500);
  });
});

describe('tryParseShellm — opt-in detection', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'shellm-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('detects a .shellm file by extension', async () => {
    const p = join(dir, 'summary.shellm');
    await writeFile(p, '#!/usr/bin/env agent-do\nSummarize the log.');
    const out = await tryParseShellm(p);
    expect(out).not.toBeNull();
    expect(out!.prompt).toBe('Summarize the log.');
  });

  it('detects a file with an agent-do shebang but no .shellm extension', async () => {
    const p = join(dir, 'notes.txt');
    await writeFile(p, '#!/usr/bin/env agent-do\nTake notes.');
    const out = await tryParseShellm(p);
    expect(out).not.toBeNull();
    expect(out!.prompt).toBe('Take notes.');
  });

  it('does NOT treat a .md file without an agent-do shebang as shellm', async () => {
    // The core ambiguity guard (issue #16, research Q4): `agent-do readme.md`
    // must stay a literal prompt, not silently read the file.
    const p = join(dir, 'readme.md');
    await writeFile(p, '# README\n\nSome documentation.');
    const out = await tryParseShellm(p);
    expect(out).toBeNull();
  });

  it('returns null for a multi-token positional (literal prompt)', async () => {
    const out = await tryParseShellm('summarize ./readme.md');
    expect(out).toBeNull();
  });

  it('returns null for a non-existent path (falls back to literal)', async () => {
    const out = await tryParseShellm(join(dir, 'no-such-file.shellm'));
    expect(out).toBeNull();
  });

  it('returns null for a directory even with a .shellm-ish name', async () => {
    const out = await tryParseShellm(dir);
    expect(out).toBeNull();
  });

  it('detects by extension even without a shebang', async () => {
    // A `.shellm` file with no shebang line is still a shellm file — the
    // extension alone is sufficient opt-in.
    const p = join(dir, 'plain.shellm');
    await writeFile(p, 'Just a prompt, no shebang.');
    const out = await tryParseShellm(p);
    expect(out).not.toBeNull();
    expect(out!.prompt).toBe('Just a prompt, no shebang.');
  });

  it('respects a shebang pointing at an absolute agent-do path', async () => {
    const p = join(dir, 'abs.shellm');
    await writeFile(p, '#!/usr/local/bin/agent-do\nRun.');
    const out = await tryParseShellm(p);
    expect(out).not.toBeNull();
    expect(out!.prompt).toBe('Run.');
  });

  it('ignores a non-agent-do shebang without the .shellm extension', async () => {
    const p = join(dir, 'script.sh');
    await writeFile(p, '#!/bin/bash\necho hi');
    const out = await tryParseShellm(p);
    expect(out).toBeNull();
  });
});

describe('readShellmFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'shellm-io-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a normal shellm file', async () => {
    const p = join(dir, 'x.shellm');
    await writeFile(p, 'hello');
    expect(await readShellmFile(p)).toBe('hello');
  });

  it('rejects a directory target', async () => {
    await expect(readShellmFile(dir)).rejects.toThrow(/not a regular file/);
  });

  it('rejects a file over the size cap', async () => {
    const p = join(dir, 'big.shellm');
    // Just over 2 MB. Cap is 2 * 1024 * 1024.
    await writeFile(p, 'x'.repeat(2 * 1024 * 1024 + 1));
    await expect(readShellmFile(p)).rejects.toThrow(/limit/);
  });
});
