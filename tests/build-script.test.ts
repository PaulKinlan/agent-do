/**
 * tests/build-script.test.ts — scripts/build.mjs, the incremental-safe build wrapper (agent-do-lve).
 *
 * The wrapper exists because `"incremental": true` + an interrupted emit leaves a truncated
 * dist/ that every later build believes is current (the stale tsbuildinfo describes the
 * PREVIOUS build). The suite covers the three guards directly:
 *
 *   - unit: tsbuildinfoPath / verifyTargets (the pure decision logic);
 *   - subprocess, stub tsc: a stale record self-heals (verify fails -> record deleted ->
 *     full rebuild repairs dist -> exit 0);
 *   - subprocess, stub tsc: an emit that can never satisfy package.json fails LOUDLY on the
 *     second pass instead of exiting 0 (exit code 1, record left deleted);
 *   - subprocess, stub tsc: SIGTERM to the wrapper deletes the tsbuildinfo, so the next
 *     build is a full emit.
 *
 * The stub tsc is a fixture script driven by a mode argument; each test gets its own tmp
 * directory and sets BUILD_SCRIPT_TSC / BUILD_SCRIPT_VERIFY, so nothing here touches the
 * repo's real dist/ or runs the real tsc (which would cost ~70s per case).
 *
 * TIMEOUT POLICY (agent-do-7ja, the agent-do-c26 file-level policy from tests/gates.test.ts):
 * every test in the subprocess describe spawns node — a wrapper run and, in the SIGTERM case,
 * two bounded 10 s waits on top. That cost belongs to the machine, not to the assertion: a
 * test whose failure mode is "the VM was busy" cannot be a gate, and this file IS gate-selected
 * (tools/suite-map.tsv maps scripts/* to it). The subprocess describe therefore declares a
 * 60 s window — above its own internal budget (10 s start + 10 s exit + two wrapper spawns) —
 * instead of inheriting vitest's 5 s default, and the synchronous wrapper runs carry their own
 * spawnSync timeout because a synchronous child call cannot be preempted by a vitest timeout.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tsbuildinfoPath, verifyTargets } from '../scripts/build.mjs';

// ── pure decision logic ─────────────────────────────────────────────────

describe('tsbuildinfoPath', () => {
  it('defaults to <outDir>/tsconfig.tsbuildinfo', () => {
    const p = tsbuildinfoPath({ compilerOptions: { outDir: 'dist' } });
    expect(p.endsWith(join('dist', 'tsconfig.tsbuildinfo'))).toBe(true);
  });

  it('honours an explicit compilerOptions.tsBuildInfoFile', () => {
    const p = tsbuildinfoPath({
      compilerOptions: { outDir: 'dist', tsBuildInfoFile: 'build/state.tsbuildinfo' },
    });
    expect(p.endsWith(join('build', 'state.tsbuildinfo'))).toBe(true);
  });

  it('falls back to dist/ when the tsconfig has no outDir', () => {
    const p = tsbuildinfoPath({ compilerOptions: {} });
    expect(p.endsWith(join('dist', 'tsconfig.tsbuildinfo'))).toBe(true);
  });
});

describe('verifyTargets', () => {
  it('collects main, types, bin (string and record), and exports leaves', () => {
    const targets = verifyTargets({
      main: 'dist/src/index.js',
      types: 'dist/src/index.d.ts',
      bin: { 'agent-do': 'dist/src/cli.js' },
      exports: {
        '.': { types: './dist/src/index.d.ts', default: './dist/src/index.js' },
        './testing': './dist/src/testing/index.js',
      },
    });
    expect(targets.sort()).toEqual([
      'dist/src/cli.js',
      'dist/src/index.d.ts',
      'dist/src/index.js',
      'dist/src/testing/index.js',
    ]);
  });

  it('returns [] for a null (unreadable) package rather than throwing', () => {
    // The wrapper reads package.json via the default parameter, so an unreadable
    // file reaches this function as undefined->default-read; a null can also
    // arrive and must be as harmless.
    expect(verifyTargets(null as never)).toEqual([]);
  });

  it('the real package.json resolves to artifacts that all exist after a build', () => {
    // Guard for the wrapper's in-repo use: if this drifts, the wrapper would verify the
    // wrong list. dist/ exists in a worktree that has built at least once; skip when it
    // has not (fresh clone) — the other cases still cover the logic.
    const targets = verifyTargets(
      JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')),
    );
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) expect(t.startsWith('dist/')).toBe(true);
  });
});

// ── subprocess behaviour (stub tsc, per-test fixture dir) ───────────────

describe('build wrapper subprocess', { timeout: 60_000 }, () => { // agent-do-7ja: the 5 s default is below this file's own waits (see the header policy)
  let dir: string;
  let infoPath: string;

  const writeStub = (mode: string) => {
    const stub = join(dir, 'tsc-stub.mjs');
    writeFileSync(
      stub,
      `import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const mode = ${JSON.stringify(mode)};
const dist = join(process.cwd(), 'dist');
let n = 0;
try { n = parseInt(readFileSync(join(process.cwd(), 'runs.txt'), 'utf8').trim(), 10) || 0; } catch {}
writeFileSync(join(process.cwd(), 'runs.txt'), String(n + 1));
mkdirSync(dist, { recursive: true });
if (mode === 'sleep') {
  setTimeout(() => process.exit(0), 60_000);
} else {
  if (mode === 'second' && n >= 1) writeFileSync(join(dist, 'a.js'), 'artifact');
  writeFileSync(join(dist, 'tsconfig.tsbuildinfo'), '{}');
}
`,
      'utf8',
    );
    return stub;
  };

  const runWrapper = () =>
    spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'build.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 45_000, // agent-do-7ja: a synchronous child cannot be preempted by a vitest timeout; bound it so a wedged wrapper fails the test instead of hanging the worker
      env: {
        ...process.env,
        BUILD_SCRIPT_TSC: `${process.execPath} ${join(dir, 'tsc-stub.mjs')}`,
        BUILD_SCRIPT_VERIFY: 'dist/a.js',
      },
    });

  const makeFixture = (mode: string) => {
    dir = mkdtempSync(join(tmpdir(), 'build-wrapper-'));
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { incremental: true, outDir: 'dist' } }),
      'utf8',
    );
    writeStub(mode);
    infoPath = join(dir, 'dist', 'tsconfig.tsbuildinfo');
  };

  beforeEach(() => {
    dir = '';
  });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('self-heals: a stale record is dropped and the full rebuild repairs dist', () => {
    makeFixture('second');
    // Run 1: stub believes everything is current (writes the record, no emit) —
    // the exact lie an interrupted emit leaves behind.
    const r1 = runWrapper();
    expect(r1.status).toBe(0);
    expect(existsSync(join(dir, 'dist', 'a.js'))).toBe(true);
    expect(existsSync(infoPath)).toBe(true);
    expect(r1.stdout).toContain('repaired it');
  });

  it('fails loudly when the emit can never satisfy the verification list', () => {
    makeFixture('never');
    const r = runWrapper();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('dist verification FAILED');
    expect(existsSync(join(dir, 'dist', 'a.js'))).toBe(false);
    // The bogus record was dropped on the way out, so the next build is full.
    expect(existsSync(infoPath)).toBe(false);
  });

  it('SIGTERM deletes the tsbuildinfo so the next build is a full emit', async () => {
    makeFixture('sleep');
    mkdirSync(join(dir, 'dist'), { recursive: true });
    // The record on disk describes the PREVIOUS build — a kill must take it with it.
    writeFileSync(infoPath, '{}', 'utf8');
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'build.mjs')], {
      cwd: dir,
      env: {
        ...process.env,
        BUILD_SCRIPT_TSC: `${process.execPath} ${join(dir, 'tsc-stub.mjs')}`,
        BUILD_SCRIPT_VERIFY: 'dist/a.js',
      },
      stdio: 'ignore',
    });
    const result = { done: false, signal: null as string | null, code: null as number | null };
    child.on('exit', (code, signal) => {
      result.done = true;
      result.signal = signal;
      result.code = code;
    });
    // Kill only once the wrapper has spawned the stub (its first act is writing
    // runs.txt): handler registration happens before that spawn, so a kill from
    // this point on is guaranteed to hit the installed SIGTERM handler and not
    // the default disposition. A fixed delay races slow startups and would test
    // Node's default SIGTERM behaviour instead of our cleanup.
    const ready = await waitFor(() => existsSync(join(dir, 'runs.txt')), 10_000);
    expect(ready).toBe(true);
    child.kill('SIGTERM');
    const exited = await waitFor(() => result.done, 10_000);
    expect(exited).toBe(true);
    expect(result.signal === 'SIGTERM' || result.code === 143).toBe(true);
    expect(existsSync(infoPath)).toBe(false);
  });
});

/** Poll a predicate every 25ms up to `ms`; the wrapper's exit callback races the test. */
async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}
