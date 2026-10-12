import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The gate is the thing that decides whether a green result means anything, so the gate gets a suite.
 *
 * WHY (docs/speed.md R5/R14, ~/fleet/docs/speed.md, fleet-1n0z): an affected-only selector is a
 * false-green generator. A changed module that maps to ZERO suites must be a loud failure, never a silent
 * no-op — a gate that runs nothing still exits 0 and reports a pass. The cases below pin that, the marker
 * vocabulary the fleet's coverage extractor parses (`fast-gate: running|passed|failed|unmapped|unknown:`),
 * and the properties of the REAL tools/suite-map.tsv.
 *
 * Everything here is hermetic: a throwaway repo per case, a stub runner, `STATIC_CMD=true`, no git, no
 * network. Nothing reads or writes a shared path, so the suite passes in any order and under load.
 */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS: string[] = [];

afterAll(() => {
  for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway checkout with this repo's tools/ and a tiny fixture of its own. */
function fixture(opts: { map?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agent-do-gates-'));
  ROOTS.push(root);
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'tests'), { recursive: true });
  mkdirSync(join(repo, 'docs'), { recursive: true });
  cpSync(join(REPO, 'tools'), join(repo, 'tools'), { recursive: true });
  // The fixture writes its OWN map: the real map is exercised by the real-repo cases below, and a case
  // that damages the map must not be able to damage the fixture's, or the next case.
  const map =
    opts.map ??
    ['src/a.ts\ttests/a.test.ts tests/b.test.ts', 'tools/*\ttests/a.test.ts', '!docs/**', '!**/*.md', '!*.md', ''].join('\n');
  writeFileSync(join(repo, 'tools', 'suite-map.tsv'), map);
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'tests', 'a.test.ts'), 'export {};\n');
  writeFileSync(join(repo, 'tests', 'b.test.ts'), 'export {};\n');
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  writeFileSync(join(repo, 'docs', 'guide.md'), '# fixture\n');

  // Stub runner: record every suite it was asked for, then exit 0 — or 1 when STUB_FAIL=1.
  const log = join(root, 'run.log');
  const stub = join(root, 'stub-runner');
  writeFileSync(
    stub,
    `#!/usr/bin/env bash\necho "$1" >> "$RUN_LOG"\n[ "\${STUB_FAIL:-0}" = 1 ] && exit 1\nexit 0\n`,
    { mode: 0o755 },
  );
  return { root, repo, log, stub };
}

type Run = { status: number | null; out: string };

function runGate(fx: ReturnType<typeof fixture>, args: string[], env: Record<string, string> = {}): Run {
  const r = spawnSync('bash', [join(fx.repo, 'tools', 'fast-gate.sh'), ...args], {
    cwd: fx.repo,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, FAST_GATE_RUNNER: fx.stub, STATIC_CMD: 'true', RUN_LOG: fx.log, ...env },
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function readLog(fx: ReturnType<typeof fixture>): string[] {
  return existsSync(fx.log) ? readFileSync(fx.log, 'utf8').split('\n').filter(Boolean) : [];
}

describe('tools/fast-gate.sh — affected-only selection', () => {
  it('runs EVERY suite the map names for a changed source file, and reports each positively', () => {
    const fx = fixture();
    const { status, out } = runGate(fx, ['--changed', 'src/a.ts']);
    expect(out).toContain('fast-gate: running: tests/a.test.ts');
    expect(out).toContain('fast-gate: running: tests/b.test.ts');
    expect(out).toContain('fast-gate: passed: tests/a.test.ts');
    expect(out).toContain('fast-gate: passed: tests/b.test.ts');
    expect(status).toBe(0);
    expect(readLog(fx).sort()).toEqual(['tests/a.test.ts', 'tests/b.test.ts']);
  });

  it('FAILS LOUDLY on a changed file that maps to no suite, and claims nothing passed', () => {
    const fx = fixture();
    const { status, out } = runGate(fx, ['--changed', 'src/untested.ts']);
    expect(out).toContain('fast-gate: unmapped: src/untested.ts');
    expect(out).not.toContain('fast-gate: passed:');
    expect(readLog(fx)).toEqual([]); // nothing may run when the map is incomplete
    expect(status).not.toBe(0);
  });

  it('maps a changed test file to itself (docs/speed.md R14 names this the measured defect)', () => {
    const fx = fixture();
    const { status, out } = runGate(fx, ['--changed', 'tests/b.test.ts']);
    expect(out).toContain('fast-gate: running: tests/b.test.ts');
    expect(readLog(fx)).toEqual(['tests/b.test.ts']);
    expect(status).toBe(0);
  });

  it('treats an exempt path as "nothing affected" (exit 0) and an unlisted file as unmapped', () => {
    const fx = fixture();
    const exempt = runGate(fx, ['--changed', 'README.md']);
    expect(exempt.out).toContain('fast-gate: no suites affected');
    expect(exempt.out).not.toContain('fast-gate: unmapped:');
    expect(exempt.status).toBe(0);

    const unlisted = runGate(fx, ['--changed', 'NOTES.txt']);
    expect(unlisted.out).toContain('fast-gate: unmapped: NOTES.txt');
    expect(unlisted.status).not.toBe(0);
  });

  it('refuses before the suites when the static step fails, and never reports that as a suite result', () => {
    const fx = fixture();
    const { status, out } = runGate(fx, ['--changed', 'src/a.ts'], { STATIC_CMD: 'false' });
    expect(out).toContain('fast-gate: unknown:');
    expect(out).not.toContain('fast-gate: passed:');
    expect(out).not.toContain('fast-gate: failed:');
    expect(readLog(fx)).toEqual([]); // no suite was reached
    expect(status).not.toBe(0);
  });

  it('reports a failing suite as failed, not as passed', () => {
    const fx = fixture();
    const { status, out } = runGate(fx, ['--changed', 'tests/a.test.ts'], { STUB_FAIL: '1' });
    expect(out).toContain('fast-gate: failed: tests/a.test.ts');
    expect(out).not.toContain('fast-gate: passed: tests/a.test.ts');
    expect(status).not.toBe(0);
  });

  it('lists the selection without running anything', () => {
    const fx = fixture();
    const { status, out } = runGate(fx, ['--list', '--changed', 'src/a.ts']);
    expect(out).toContain('tests/a.test.ts');
    expect(readLog(fx)).toEqual([]);
    expect(status).toBe(0);
  });

  it('refuses to guess when the map is missing, and when a mapped suite does not exist', () => {
    const noMap = fixture({ map: '' });
    rmSync(join(noMap.repo, 'tools', 'suite-map.tsv'));
    const missingMap = runGate(noMap, ['--changed', 'src/a.ts']);
    expect(missingMap.out).toContain('the map IS the gate');
    expect(missingMap.status).not.toBe(0);

    const stale = fixture({ map: ['src/a.ts\ttests/gone.test.ts', ''].join('\n') });
    const staleMap = runGate(stale, ['--changed', 'src/a.ts']);
    expect(staleMap.out).toContain('fast-gate: missing: tests/gone.test.ts');
    expect(staleMap.status).not.toBe(0);
  });
});

describe('tools/suite-map.tsv — the committed map is a true claim', () => {
  function mapRows(): { pattern: string; suites: string[] }[] {
    const text = readFileSync(join(REPO, 'tools', 'suite-map.tsv'), 'utf8');
    return text
      .split('\n')
      .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('!'))
      .map((l) => {
        const [pattern, rest] = l.split('\t');
        return { pattern, suites: (rest ?? '').split(/\s+/).filter(Boolean) };
      });
  }

  it('is in sync with the test import graph (node tools/gen-suite-map.mjs --check)', () => {
    const r = spawnSync('node', [join(REPO, 'tools', 'gen-suite-map.mjs'), '--check'], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(`${r.stdout ?? ''}${r.stderr ?? ''}`).toContain('suite-map:');
    expect(r.status).toBe(0);
  });

  it('names only suites that exist (a renamed suite otherwise reads green forever)', () => {
    for (const row of mapRows()) {
      for (const suite of row.suites) {
        expect(existsSync(join(REPO, suite)), `${row.pattern} names a missing suite: ${suite}`).toBe(true);
      }
    }
  });

  // Every shipped module is either covered by a mapped suite or on this list, deliberately. A module that
  // is on neither is UNMAPPED, so tools/fast-gate.sh fails on any change to it — correct, but it should be
  // learned here (with the reason) rather than from a red gate. Adding a module with no suite therefore
  // fails this test: write the suite, or add the row with its reason.
  const KNOWN_WITHOUT_SUITE: Record<string, string> = {
    'src/cli.ts': 'the bin entry point (argument parsing lives in src/cli/args.ts, which IS covered)',
    'src/cli/eval-cmd.ts': 'the `eval` subcommand wiring; the eval runner+assertions are covered',
    'src/cli/prompt.ts': 'interactive/one-shot prompt mode; needs a TTY to drive',
    'src/prompts/index.ts': 'public barrel re-export; the modules it re-exports are covered',
    'src/eval/index.ts': 'public barrel re-export; the modules it re-exports are covered',
  };

  it('has a row for every module under src/, or a named reason it has none', () => {
    const mapped = new Set(mapRows().map((r) => r.pattern));
    const walk = (dir: string): string[] =>
      readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(join(dir, e.name))
          : e.isFile() && e.name.endsWith('.ts')
            ? [join(dir, e.name)]
            : [],
      );
    const uncovered = walk('src').filter((f) => !mapped.has(f) && !(f in KNOWN_WITHOUT_SUITE));
    expect(
      uncovered,
      'these modules have no mapped suite and no recorded reason; add a suite, or add the file to KNOWN_WITHOUT_SUITE',
    ).toEqual([]);
  });
});
