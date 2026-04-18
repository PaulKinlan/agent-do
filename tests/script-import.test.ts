import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parseArgs } from '../src/cli/args.js';
import { runScriptMode, importScriptFile } from '../src/cli/script.js';
import type { ParsedArgs } from '../src/cli/args.js';

// ─── #19 C-03: CLI flag surface ──────────────────────────────────────────

describe('parseArgs: --script and --yes', () => {
  it('defaults both to false', () => {
    const args = parseArgs([]);
    expect(args.script).toBe(false);
    expect(args.yes).toBe(false);
  });

  it('parses --script', () => {
    const args = parseArgs(['run', './a.ts', '--script']);
    expect(args.script).toBe(true);
  });

  it('parses --yes and -y', () => {
    expect(parseArgs(['run', './a.ts', '--yes']).yes).toBe(true);
    expect(parseArgs(['run', './a.ts', '-y']).yes).toBe(true);
  });
});

// ─── #19 C-03: path-vs-name disambiguation ──────────────────────────────

function baseArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command: 'run',
    provider: 'anthropic',
    systemPrompt: '',
    workingDir: process.cwd(),
    memoryDir: '.agent-do',
    withMemory: false,
    readOnly: false,
    maxIterations: 20,
    noTools: true, // keep the sandbox tight in tests
    verbose: false,
    showContent: false,
    json: false,
    help: false,
    exclude: [],
    includeSensitive: false,
    output: 'console',
    concurrency: 1,
    script: false,
    yes: false,
    acceptAll: false,
    allow: [],
    logLevel: 'info',
    ...overrides,
  };
}

describe('runScriptMode dispatcher', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-do-script-'));
    process.chdir(tmpDir);
  });
  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('treats saved-agent-shaped names as saved agents, not scripts', async () => {
    // No saved agent exists and no file either — must fail with the
    // saved-agent error, *not* fall through to an import attempt.
    await expect(
      runScriptMode(baseArgs({ file: 'nonexistent-agent' })),
    ).rejects.toThrow(/No saved agent "nonexistent-agent"/);
  });

  it('refuses to import a script path without --script', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'evil.js'),
      "throw new Error('should never import');",
    );
    await expect(
      runScriptMode(baseArgs({ file: './evil.js' })),
    ).rejects.toThrow(/requires --script/);
  });

  it('refuses a script outside cwd even with --script', async () => {
    // Relative path that escapes cwd.
    await expect(
      runScriptMode(
        baseArgs({ file: '../escape.js', script: true, yes: true }),
      ),
    ).rejects.toThrow(/outside the working directory/);
  });

  it('refuses an extension that isn\'t in the allowlist', async () => {
    fs.writeFileSync(path.join(tmpDir, 'evil.sh'), 'echo pwn');
    // `.sh` is not a script extension — the dispatcher falls through to
    // the saved-agent branch because it doesn't look like a path *nor*
    // a script extension... except it *does* start with `./`. Which
    // means it hits the --script gate first.
    await expect(
      runScriptMode(
        baseArgs({ file: './evil.sh', script: true, yes: true }),
      ),
    ).rejects.toThrow(/only .* files are allowed/);
  });

  it('does not attempt to import when saved-agent lookup fails (no silent fallback)', async () => {
    // Plant a file named `security-reviewer.js` in cwd — the old code
    // path would import it after the saved-agent lookup missed. The
    // fix leaves the saved-agent branch alone because `security-reviewer`
    // doesn't look like a path.
    const planted = path.join(tmpDir, 'security-reviewer.js');
    fs.writeFileSync(
      planted,
      "throw new Error('silent fallback import happened!');",
    );
    await expect(
      runScriptMode(baseArgs({ file: 'security-reviewer' })),
    ).rejects.toThrow(/No saved agent/);
  });
});

// ─── #19 C-03: importScriptFile unit coverage ───────────────────────────

describe('importScriptFile', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-do-import-'));
    process.chdir(tmpDir);
  });
  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects a path escaping cwd via ../', async () => {
    await expect(
      importScriptFile('../outside.js', { yes: true }),
    ).rejects.toThrow(/outside the working directory/);
  });

  it('rejects a non-existent file', async () => {
    await expect(
      importScriptFile('./missing.js', { yes: true }),
    ).rejects.toThrow(/not found/);
  });

  it('accepts a legit script when cwd is reached via a symlink (Codex #66 follow-up)', async () => {
    // Codex re-review on #66: if the shell cwd is a symlink path
    // (e.g. `/var/...` on macOS, which realpath resolves to
    // `/private/var/...`), the fast-fail containment check used to
    // compare non-canonical `requested` against canonical `cwd` and
    // reject every legit script. The realpathSafe-based fix
    // canonicalises ancestors of `requested` too.
    const linkedRoot = path.join(os.tmpdir(), `agent-do-linked-${process.pid}`);
    // Skip gracefully if we can't create a symlink (e.g. in a CI
    // sandbox that forbids it); no point in a flaky test.
    try {
      fs.symlinkSync(tmpDir, linkedRoot);
    } catch {
      return;
    }
    try {
      const originalCwdLocal = process.cwd();
      fs.writeFileSync(
        path.join(tmpDir, 'legit.mjs'),
        'export default { ok: true };\n',
      );
      try {
        process.chdir(linkedRoot);
        const mod = await importScriptFile('./legit.mjs', { yes: true });
        expect((mod.default as Record<string, unknown>).ok).toBe(true);
      } finally {
        process.chdir(originalCwdLocal);
      }
    } finally {
      // Symlinks need `unlink`, not `rmSync` (which refuses to delete
      // a directory-symlink without `recursive: true` and would then
      // recurse into the real directory we don't want to touch).
      try { fs.unlinkSync(linkedRoot); } catch { /* already gone */ }
    }
  });

  it('rejects a symlink pointing outside cwd (Codex #66 P2)', async () => {
    // Plant a file outside cwd, symlink it into cwd with a trusted-
    // looking name. `path.resolve(rawPath)` stays inside cwd (the
    // symlink path is inside) but realpath reveals the escape.
    const outside = path.join(os.tmpdir(), `agent-do-escape-${process.pid}.mjs`);
    fs.writeFileSync(outside, "export default { pwned: true };\n");
    try {
      fs.symlinkSync(outside, path.join(tmpDir, 'trusted.mjs'));
      await expect(
        importScriptFile('./trusted.mjs', { yes: true }),
      ).rejects.toThrow(/outside the working directory/);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('rejects a directory that has a script-like extension (isFile check)', async () => {
    // With isFile() we reject directories explicitly. The old R_OK
    // check would have passed a readable directory and then produced
    // a less clear error at import time.
    fs.mkdirSync(path.join(tmpDir, 'fake.mjs'));
    await expect(
      importScriptFile('./fake.mjs', { yes: true }),
    ).rejects.toThrow(/not a regular file/);
  });

  it('rejects a disallowed extension', async () => {
    fs.writeFileSync(path.join(tmpDir, 'nope.txt'), 'data');
    await expect(
      importScriptFile('./nope.txt', { yes: true }),
    ).rejects.toThrow(/only .* files are allowed/);
  });

  it('imports a valid .mjs file with --yes', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'good.mjs'),
      'export default { name: "from-script", ok: true };\n',
    );
    const mod = await importScriptFile('./good.mjs', { yes: true });
    expect((mod.default as Record<string, unknown>).ok).toBe(true);
    expect((mod.default as Record<string, unknown>).name).toBe('from-script');
  });

  it('refuses in non-TTY context without --yes', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'a.mjs'),
      'export default { name: "x" };\n',
    );
    // vitest runs non-interactively; stdin is not a TTY. Without --yes,
    // confirmScriptImport returns false and importScriptFile throws.
    // Mock stdin.isTTY to guarantee non-TTY semantics regardless of env.
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    });
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(() => true) as any;
    try {
      await expect(
        importScriptFile('./a.mjs', { yes: false }),
      ).rejects.toThrow(/Aborted by user/);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      });
      stderrSpy.mockRestore();
    }
  });
});
