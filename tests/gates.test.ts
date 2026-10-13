import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
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

/**
 * Fixture teardown has to stop processes as well as delete directories, and it has to do it before the
 * directory goes away: the path IS the handle. The probe below is bounded on purpose - a fix for leaks
 * must not become the next leak, so the test never depends on the code under test to end it.
 */
describe('fixture teardown', () => {
  it('kills a process still running out of the fixture root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-do-gates-'));
    ROOTS.push(root);
    const marker = join(root, 'probe');
    const child = spawn('bash', ['-c', 'while :; do sleep 1; done', marker]);
    try {
      await once(child, 'spawn');
      await new Promise((done) => setTimeout(done, 250));
      const pids = () => spawnSync('pgrep', ['-f', '--', `${root}/`], { encoding: 'utf8' }).stdout.trim();
      expect(pids(), 'the probe must be visible to the same match teardown uses').not.toBe('');

      expect(reapFixtureProcesses(root)).toBeGreaterThan(0);
      expect(pids(), 'teardown must leave nothing matching the fixture root').toBe('');
      const exited = await Promise.race([
        once(child, 'exit').then(() => true),
        new Promise((done) => setTimeout(() => done(false), 2000)),
      ]);
      expect(exited, 'the probe itself must be gone, not merely detached').toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('reaps a descendant that does not carry the fixture root in its argv', async () => {
    // agent-do-63t: the pattern match sees processes that MENTION the root, and a child like `sleep 5` does
    // not - `bash -c 'sleep 5'` would exec into sleep and lose the marker entirely, which is why the probe
    // below keeps a shell alive and backgrounds the child inside it. The probe is bounded at five seconds
    // on purpose: if the walk regresses, the test fails and nothing is left running for long.
    const root = mkdtempSync(join(tmpdir(), 'agent-do-gates-'));
    ROOTS.push(root);
    const childPidFile = join(root, 'child.pid');
    const child = spawn('bash', ['-c', 'sleep 5 & echo $! > "$1"; wait', join(root, 'probe'), childPidFile]);
    try {
      await once(child, 'spawn');
      const deadline = Date.now() + 3000;
      while (!existsSync(childPidFile) && Date.now() < deadline) sleepSync(50);
      const grandchild = readFileSync(childPidFile, 'utf8').trim();
      const alive = () => spawnSync('kill', ['-0', grandchild]).status === 0;
      expect(grandchild, 'the probe must record its rootless child').toMatch(/^\d+$/);
      expect(alive(), 'the rootless child must be running before teardown').toBe(true);

      expect(reapFixtureProcesses(root), 'both the matched process and its descendant').toBeGreaterThan(1);
      const gone = Date.now() + 2000;
      while (alive() && Date.now() < gone) sleepSync(25);
      expect(alive(), 'a cmdline match alone would leave this child behind').toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('reaps a child that a TERM handler spawns after the snapshot', async () => {
    // agent-do-51j, filed by rev-58: the process is matched and alive, and it forks only once TERM arrives,
    // so the child exists after any single snapshot. Its cwd is the fixture root, which is how teardown can
    // still find it if the parent is already gone by then. Bounded at five seconds like the other probe.
    const root = mkdtempSync(join(tmpdir(), 'agent-do-gates-'));
    ROOTS.push(root);
    const lateChildPidFile = join(root, 'term-child.pid');
    const child = spawn(
      'bash',
      [
        '-c',
        'trap \'sleep 5 & echo $! > "$1"\' TERM; while :; do sleep 1; done',
        join(root, 'probe'),
        lateChildPidFile,
      ],
      { cwd: root },
    );
    try {
      await once(child, 'spawn');
      await new Promise((done) => setTimeout(done, 300));
      expect(
        spawnSync('pgrep', ['-f', '--', `${root}/`], { encoding: 'utf8' }).stdout.trim(),
        'the probe must be matched before teardown',
      ).not.toBe('');

      expect(reapFixtureProcesses(root)).toBeGreaterThan(1);
      expect(existsSync(lateChildPidFile), 'the TERM handler must have run').toBe(true);
      const late = readFileSync(lateChildPidFile, 'utf8').trim();
      expect(late, 'the handler must record a pid').toMatch(/^\d+$/);
      const alive = () => spawnSync('kill', ['-0', late]).status === 0;
      const gone = Date.now() + 2000;
      while (alive() && Date.now() < gone) sleepSync(25);
      expect(alive(), 'a snapshot taken before TERM cannot see this child').toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  });
});

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Kill anything still running out of a fixture root, while the path is still there to match on.
 *
 * WHY this exists: a bound-kill case deliberately starts a gate that will not stop on its own. While the
 * suite is exercising a revision that does NOT reap (that is the behaviour under test when the case is
 * written against an older tip), the gate can outlive the assertion, and today's leak showed what that
 * costs: five orphaned fixture gates, stuck for two hours in the static step, each one invisible to the
 * reaper because its argv contains no marker-shaped name. Cleanup that only removes the directory is not
 * cleanup - it leaves the process running against a path that no longer exists, which nothing can then
 * find. The pattern carries the trailing separator so a sibling fixture (or a longer mkdtemp name) can
 * never match, and it is applied BEFORE the removal for the same reason it is applied at all.
 *
 * Reach is two stages, because a cmdline match cannot see everything: the pattern finds the processes that
 * mention the root, and then their descendants are walked and taken as well. A child such as `sleep 30`
 * carries no root in its argv, so matching alone would leave it behind - agent-do-63t. The walk runs before
 * any signal is sent: a dead parent reparents its children and the link that made them findable is gone,
 * and `pgrep -P` cannot see a process that has already been reparented. The remaining limit is exactly
 * that: a process whose root-carrying ancestor died before teardown is already unfindable.
 *
 * Two further reaches, from the same lesson that a single snapshot is not a guarantee. Processes whose
 * WORKING DIRECTORY is inside the fixture are matched too: the suite runs its fixture commands with the
 * fixture repo as cwd, a child inherits it, and a reparented child is otherwise unfindable - agent-do-51j.
 * And the grace period re-collects on every pass rather than trusting the first snapshot, because a process
 * is free to spawn work while it handles the TERM just delivered to it. What stays out of reach is named
 * rather than assumed away: a TERM handler that also changes directory and carries no root in argv, and
 * another user's process, whose /proc entry cannot be read at all.
 */
function reapFixtureProcesses(root: string): number {
  const pattern = `${root}/`;
  const list = (args: string[]) =>
    spawnSync('pgrep', args, { encoding: 'utf8' })
      .stdout.split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  const alive = (pid: string) => spawnSync('kill', ['-0', pid]).status === 0;

  // A child that inherits the fixture as its working directory is findable even after its parent is gone,
  // which is the case a walk cannot reach. This runs on EVERY pass, including passes where the argv match is
  // empty, and that is deliberate rather than an oversight: by the second pass the parent is usually gone,
  // so an empty argv match is exactly the situation where cwd is the only handle left on a reparented child.
  // Guarding this on a non-empty argv match would silently reintroduce agent-do-51j. The cost is one /proc
  // scan only while a fixture has actually leaked something, and another user's process reads as an error
  // and is skipped.
  const byWorkingDirectory = () => {
    if (!existsSync('/proc')) return [];
    const found: string[] = [];
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const cwd = readlinkSync(`/proc/${entry}/cwd`);
        if (cwd === root || cwd.startsWith(pattern)) found.push(entry);
      } catch {
        // Exited between the listing and the read, or not ours to inspect.
      }
    }
    return found;
  };

  const targets = new Set<string>();
  const collect = () => {
    const queue = [...list(['-f', '--', pattern]), ...byWorkingDirectory()];
    while (queue.length > 0) {
      const pid = queue.pop() as string;
      if (targets.has(pid)) continue;
      targets.add(pid);
      queue.push(...list(['-P', pid]));
    }
  };

  collect();
  if (targets.size === 0) return 0;
  spawnSync('kill', ['-TERM', ...targets]);
  // A gate wedged behind a foreground child ignores TERM until that child exits - the exact bug this file
  // pins - so the wait is short and the KILL is what actually ends it. The loop re-collects instead of
  // trusting one snapshot, because a process may spawn more work while handling the TERM it was just sent,
  // and that child exists only after any snapshot taken beforehand (agent-do-51j). The early exit still has
  // to consider descendants and not just pattern matches: a TERM-killed parent leaves the pattern while its
  // rootless child is running, and returning there would skip the KILL that child needs.
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    sleepSync(50);
    collect();
    if ([...targets].every((pid) => !alive(pid))) return targets.size;
  }
  collect();
  spawnSync('kill', ['-KILL', ...targets]);
  return targets.size;
}

afterAll(() => {
  for (const dir of ROOTS) {
    reapFixtureProcesses(dir);
    rmSync(dir, { recursive: true, force: true });
  }
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

/** The unmapped paths a run reported, in order — the marker ~/fleet/remote/check-coverage.py harvests. */
function unmappedLines(out: string): string[] {
  return out
    .split('\n')
    .filter((l) => l.startsWith('fast-gate: unmapped: '))
    .map((l) => l.slice('fast-gate: unmapped: '.length));
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

  it('reports one unmapped path per changed file, even when the path contains a space', () => {
    const fx = fixture();
    const { out } = runGate(fx, ['--changed', 'src/a b.ts']);
    expect(unmappedLines(out)).toEqual(['src/a b.ts']);
  });

  it('never pathname-expands a changed path, so it cannot name a file that did not change', () => {
    // The fixture has src/a.ts. Before this case existed the loop was `for f in $(printf ...)`, whose
    // unquoted substitution expands `src/*.ts` against the checkout: the record then named src/a.ts — a
    // path that did NOT change — as unmapped. The map only knows src/a.ts, so the glob is unmapped itself.
    const fx = fixture();
    const { out } = runGate(fx, ['--changed', 'src/*.ts']);
    expect(unmappedLines(out)).toEqual(['src/*.ts']);
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

describe('tools/fast-gate.sh — kill windows', () => {
  it('bounds one suite well inside the outer fast-tier kill window', () => {
    // A per-suite bound that is not below the outer window is a race: whichever fires first decides, and
    // when the outer one does, a hung suite is recorded as `unknown` instead of `fast-gate: failed: X`
    // with its log tail. That was the case with 180 s in both places; the relationship is asserted here
    // rather than left to a comment, so raising one of them alone goes red.
    const gate = readFileSync(join(REPO, 'tools', 'fast-gate.sh'), 'utf8');
    const bound = Number(/^SUITE_BOUND=\$\{SUITE_BOUND:-(\d+)\}/m.exec(gate)?.[1]);
    const outer = Number(/^CHECK_FAST_TIMEOUT=(\d+)/m.exec(readFileSync(join(REPO, 'tools', 'check.conf'), 'utf8'))?.[1]);
    expect(Number.isFinite(bound), 'SUITE_BOUND default must be a literal number in tools/fast-gate.sh').toBe(true);
    expect(Number.isFinite(outer), 'CHECK_FAST_TIMEOUT must be a literal number in tools/check.conf').toBe(true);
    // 15 s is the SIGKILL grace the runner is given (`timeout -k 15`): the bound must be able to fire,
    // escalate, and still leave the gate time to name the suite before the outer window ends.
    expect(bound + 15).toBeLessThan(outer);
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

  // The fleet's coverage extractor (~/fleet/remote/check-coverage.py) does NOT read the map above: it looks
  // for a test file whose NAME corresponds to the changed file. Without this contract every module whose
  // suite is not eponymous is published in the cached fast verdict as `unmapped` at the moment its suites
  // really did run. So the contract is not a copy of the map — it is the other half of the integration.
  it('tells the fleet extractor the mappings its naming oracle cannot see', () => {
    const contract: Record<string, string[]> = JSON.parse(readFileSync(join(REPO, 'tests', 'coverage-contract.json'), 'utf8'));
    expect(contract['src/cli/args.ts']).toContain('tests/cli-args.test.ts'); // not eponymous: args -> cli-args
    expect(contract['tools/*']).toEqual(['tests/gates.test.ts']); // a changed gate script -> the gate suite
    for (const [pattern, suites] of Object.entries(contract)) {
      expect(suites.length, `${pattern} has no suites`).toBeGreaterThan(0);
      for (const suite of suites) expect(existsSync(join(REPO, suite)), `${pattern} -> missing ${suite}`).toBe(true);
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

/**
 * agent-do-qmx: when the outer window (CHECK_FAST_TIMEOUT) kills the gate, the run used to end with one
 * `No such file or directory` shell error per suite and left the in-flight runners holding the heavy slot
 * until fleet-heavy reaped them. These cases pin the cleanup: the scratch directory goes away only after
 * the suite processes do, and a descendant of a runner cannot outlive the run.
 */
describe('tools/fast-gate.sh — cleanup when the run is killed', () => {
  /** How long the run gets before the outer window fires; the stub below never finishes on its own. */
  const OUTER_WINDOW_MS = 3_000;

  it('kills the suite processes, takes their descendants with them, and does not race the scratch dir', async () => {
    const fx = fixture();
    const marker = `agent-do-gates-reap-${process.pid}-${Date.now()}`;
    const pidFile = join(fx.root, 'pids.txt');
    const stub = join(fx.root, 'stub-hanger');
    // The runner records its own pid and then starts a descendant that carries the marker in its argv. The
    // descendant must NOT be a single simple command: `bash -c 'sleep 300'` execs into `sleep`, which
    // replaces the command line and would drop the marker, making the assertion below match nothing at all.
    writeFileSync(
      stub,
      `#!/usr/bin/env bash
echo "$1" >> "$RUN_LOG"
echo "$$" >> "$PID_FILE"
bash -c 'while :; do sleep 5; done' "$MARKER" &
echo "$!" >> "$PID_FILE"
wait
`,
      { mode: 0o755 },
    );

    const r = spawnSync('bash', [join(fx.repo, 'tools', 'fast-gate.sh'), '--changed', 'src/a.ts'], {
      cwd: fx.repo,
      encoding: 'utf8',
      timeout: OUTER_WINDOW_MS,
      env: {
        ...process.env,
        FAST_GATE_RUNNER: stub,
        STATIC_CMD: 'true',
        RUN_LOG: fx.log,
        PID_FILE: pidFile,
        MARKER: marker,
        FAST_GATE_JOBS: '1',
      },
    });

    // The run was killed by the bound rather than finishing. Post-fix that is the TERM trap exiting with
    // 130; pre-fix bash dies from the signal and spawnSync reports no status at all. Both mean "killed".
    expect(r.status).not.toBe(0);
    expect(r.status === 130 || r.status === null || r.signal === 'SIGTERM').toBe(true);
    expect(existsSync(pidFile)).toBe(true); // the stub really did start

    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    // The old trap removed $TMP while the subshells were still writing their `.rc` files.
    expect(output).not.toContain('No such file or directory');

    // The runner's descendant must be gone: cleanup signals the process group, so a child of the runner (not
    // of this script) dies with it. Without that, this is the leak fleet-heavy used to have to clean up.
    const pids = readFileSync(pidFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(Number);
    let stillAlive = true;
    for (let i = 0; i < 20 && stillAlive; i++) {
      stillAlive = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).status === 0;
      if (stillAlive) await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
    }
    if (stillAlive) {
      // Do not leak the descendant out of a failing run: kill what the fix failed to kill.
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
    if (stillAlive) {
      console.error('[diag bound-kill] inner gate output:\n' + output);
      const ps = spawnSync('ps', ['-eo', 'pid,sid,pgid,stat,args'], { encoding: 'utf8' }).stdout ?? '';
      console.error(ps.split('\n').filter((l) => l.includes(marker)).join('\n'));
      console.error('[diag trace] ' + (readFileSync(process.env.FAST_GATE_DEBUG ?? '/dev/null', 'utf8') || 'no trace'));
    }
    expect(stillAlive, 'a descendant of the killed suite runner outlived the gate').toBe(false);
  }, 30_000);
});

describe('tools/fast-gate.sh — a suite that leaves a process behind', () => {
  it('reaps a descendant of a runner that exited successfully, and still reports the verdict', async () => {
    // This is the shape fleet-heavy caught on a PASSING run (agent-do-qmx): three vitest processes held the
    // heavy slot after the job finished. The runner here exits 0 and leaves a descendant, which is the part the
    // pid-based cleanup cannot see — the subshell is reaped, the descendant is reparented, and `timeout` put
    // the runner in its own process group, so only session membership still links them.
    const fx = fixture();
    const marker = `agent-do-gates-leftover-${process.pid}-${Date.now()}`;
    const stub = join(fx.root, 'stub-leaky');
    writeFileSync(
      stub,
      `#!/usr/bin/env bash
echo "$1" >> "$RUN_LOG"
# Not a single simple command: bash -c with one command would exec and drop the marker.
bash -c 'while :; do sleep 5; done' "$MARKER" &
exit 0
`,
      { mode: 0o755 },
    );

    const r = spawnSync('bash', [join(fx.repo, 'tools', 'fast-gate.sh'), '--changed', 'src/a.ts'], {
      cwd: fx.repo,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, FAST_GATE_RUNNER: stub, STATIC_CMD: 'true', RUN_LOG: fx.log, MARKER: marker },
    });

    // The gate must still deliver its verdict: the cleanup runs after the suites have reported.
    expect(`${r.stdout ?? ''}${r.stderr ?? ''}`).toContain('fast-gate: passed: tests/a.test.ts');
    expect(r.status).toBe(0);

    let stillAlive = true;
    for (let i = 0; i < 20 && stillAlive; i++) {
      stillAlive = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).status === 0;
      if (stillAlive) await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
    }
    if (stillAlive) {
      const leaked = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).stdout ?? '';
      for (const pid of leaked.split('\n').filter(Boolean)) {
        try {
          process.kill(Number(pid), 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
    if (stillAlive) {
      console.error('[diag leftover] inner gate output:\n' + `${r.stdout ?? ''}${r.stderr ?? ''}`);
      const ps = spawnSync('ps', ['-eo', 'pid,sid,pgid,stat,args'], { encoding: 'utf8' }).stdout ?? '';
      console.error(ps.split('\n').filter((l) => l.includes(marker)).join('\n'));
      console.error('[diag trace] ' + (readFileSync(process.env.FAST_GATE_DEBUG ?? '/dev/null', 'utf8') || 'no trace'));
    }
    expect(stillAlive, 'a suite left a process behind after the gate reported its verdict').toBe(false);
  }, 30_000);
});

describe('tools/fast-gate.sh — reaping must not depend on helper processes', () => {
  it('reaps the suite tree even when pgrep and pkill fail', async () => {
    // The measured failure this guards (agent-do-qmx round 3): the reaper shelled out to `pgrep`/`pkill` with every
    // failure swallowed, so under contention — a run sharing the VM with the merger's full gate — those forks
    // failed and the reaper killed nothing at all. The same suite passed on an idle VM and failed on a loaded one.
    // The reaper now reads /proc and signals with the `kill` builtin, so failing helpers change nothing.
    const fx = fixture();
    const shim = join(fx.root, 'bin');
    mkdirSync(shim, { recursive: true });
    for (const tool of ['pgrep', 'pkill'] as const) {
      writeFileSync(join(shim, tool), '#!/bin/sh\necho "shim: $0 refuses to work" >&2\nexit 127\n', { mode: 0o755 });
    }
    const marker = `agent-do-gates-nofork-${process.pid}-${Date.now()}`;
    const stub = join(fx.root, 'stub-leaky-nofork');
    writeFileSync(
      stub,
      `#!/usr/bin/env bash
echo "$1" >> "$RUN_LOG"
bash -c 'while :; do sleep 5; done' "$MARKER" &
exit 0
`,
      { mode: 0o755 },
    );

    const r = spawnSync('bash', [join(fx.repo, 'tools', 'fast-gate.sh'), '--changed', 'src/a.ts'], {
      cwd: fx.repo,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        PATH: `${shim}:${process.env.PATH ?? ''}`,
        FAST_GATE_RUNNER: stub,
        STATIC_CMD: 'true',
        RUN_LOG: fx.log,
        MARKER: marker,
      },
    });

    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(output).toContain('fast-gate: passed: tests/a.test.ts');
    expect(r.status).toBe(0);

    let stillAlive = true;
    for (let i = 0; i < 20 && stillAlive; i++) {
      stillAlive = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).status === 0;
      if (stillAlive) await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
    }
    if (stillAlive) {
      const leaked = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).stdout ?? '';
      for (const pid of leaked.split('\n').filter(Boolean)) {
        try {
          process.kill(Number(pid), 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
    expect(stillAlive, 'the reaper needed its helpers: a descendant survived with pgrep/pkill failing').toBe(false);
  }, 30_000);
});

describe('tools/fast-gate.sh — teardown before the caller checks the slot', () => {
  it('does not return while a killed descendant is still exiting', async () => {
    // agent-do-qmx, P2 from the pre-landing review: fleet-heavy checks the slot holders the instant the job
    // ends, and a descendant caught mid-exit there is reported as a leaked process (measured: one pid on a run
    // whose own scan found nothing a second later). The gate now waits, bounded, for its sessions to empty
    // before returning, so the check immediately after it returns must find nothing. No sleep in the assertion:
    // the point is the instant the gate returns.
    const fx = fixture();
    const marker = `agent-do-gates-teardown-${process.pid}-${Date.now()}`;
    const stub = join(fx.root, 'stub-stubborn');
    writeFileSync(
      stub,
      `#!/usr/bin/env bash
echo "$1" >> "$RUN_LOG"
# Ignores TERM, so only the KILL pass ends it — the case where teardown takes the longest.
bash -c 'trap "" TERM; while :; do sleep 5; done' "$MARKER" &
exit 0
`,
      { mode: 0o755 },
    );

    const r = spawnSync('bash', [join(fx.repo, 'tools', 'fast-gate.sh'), '--changed', 'src/a.ts'], {
      cwd: fx.repo,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, FAST_GATE_RUNNER: stub, STATIC_CMD: 'true', RUN_LOG: fx.log, MARKER: marker },
    });

    expect(`${r.stdout ?? ''}${r.stderr ?? ''}`).toContain('fast-gate: passed: tests/a.test.ts');
    expect(r.status).toBe(0);

    const stillExiting = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).status === 0;
    if (stillExiting) {
      const leaked = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).stdout ?? '';
      for (const pid of leaked.split('\n').filter(Boolean)) {
        try {
          process.kill(Number(pid), 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
    expect(stillExiting, 'a descendant was still exiting when the gate returned').toBe(false);
  }, 30_000);
});

describe('tools/fast-gate.sh — the bound kill still leaves a verdict', () => {
  it('prints a fast-gate: unknown marker when the outer bound kills it', async () => {
    // agent-do-wot (found by rev-45 reviewing agent-do-qmx): the TERM path reaped the tree but exited without
    // saying anything, so the coverage extractor saw no result at all — the exact failure this bead exists to
    // fix. The marker must be line-anchored, because remote/check-coverage.py matches ^fast-gate:\s*unknown:
    const fx = fixture();
    const hang = join(fx.root, 'hang');
    writeFileSync(hang, '#!/usr/bin/env bash\nwhile :; do sleep 1; done\n', { mode: 0o755 });

    // `timeout --foreground -k 5 3` mirrors the real path exactly: fleet-check invokes the gate as
    // `timeout --foreground -k 30 180 ...`, and --foreground matters — without it coreutils signals the whole
    // process group, which would mask a leak this test is meant to catch.
    const r = spawnSync(
      'timeout',
      ['--foreground', '-k', '5', '3', 'bash', join(fx.repo, 'tools', 'fast-gate.sh'), '--changed', 'src/a.ts'],
      {
        cwd: fx.repo,
        encoding: 'utf8',
        timeout: 40_000,
        env: { ...process.env, FAST_GATE_RUNNER: hang, STATIC_CMD: 'true' },
      },
    );

    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    // 124 is the bound's own exit code: it proves the TERM path ran, not some other branch that prints a marker.
    expect(r.status).toBe(124);
    expect(out).toMatch(/^fast-gate: unknown: /m);
    expect(out).toContain('killed by the outer bound');
    // And it must not claim a suite result it never produced.
    expect(out).not.toMatch(/^fast-gate: (?:PASS|FAIL)/m);
    expect(out).not.toMatch(/^fast-gate: passed: /m);
  }, 45_000);
});

describe('tools/fast-gate.sh — a bound kill during the static step', () => {
  it('prints the unknown marker and reaps the static step', async () => {
    // rev-48, review round 3: the traps were installed AFTER STATIC_CMD, so a bound kill during the static step
    // emitted no marker at all (the same defect one stage earlier) and left the step's process holding the heavy
    // slot. The traps now sit above the static step, which runs in its own recorded session so the same trap
    // reaps it.
    const fx = fixture();
    const stub = join(fx.root, `static-hang-${process.pid}-${Date.now()}`);
    writeFileSync(stub, '#!/usr/bin/env bash\nwhile :; do sleep 1; done\n', { mode: 0o755 });

    // --foreground again: fleet-check's real bound does not signal the process group, so a static step left
    // running after the bound fires is exactly what this case must catch.
    const r = spawnSync(
      'timeout',
      ['--foreground', '-k', '5', '3', 'bash', join(fx.repo, 'tools', 'fast-gate.sh'), '--changed', 'tests/gates.test.ts'],
      {
        cwd: fx.repo,
        encoding: 'utf8',
        timeout: 40_000,
        env: { ...process.env, FAST_GATE_RUNNER: 'true', STATIC_CMD: stub },
      },
    );

    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(r.status).toBe(124);
    expect(out).toMatch(/^fast-gate: unknown: /m);
    expect(out).toContain('killed by the outer bound');

    const leaked = (spawnSync('pgrep', ['-f', stub], { encoding: 'utf8' }).stdout ?? '').trim();
    for (const pid of leaked.split('\n').filter(Boolean)) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        // already gone
      }
    }
    expect(leaked, 'the killed static step was left running').toBe('');
  }, 45_000);
});

