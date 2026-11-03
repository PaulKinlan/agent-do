import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
 * Every test in this file that spawns a gate runs bash, node and a stub runner: the cost belongs to the
 * machine, not to the assertion. Vitest's 5 s default turned three of them red in a full gate on this
 * 2-vCPU VM while they pass in under a second alone (agent-do-c26), so each describe that spawns declares
 * its own window. This is the file-level policy, not a per-test exception: a test whose failure mode is
 * "the VM was busy" cannot be a gate.
 */

/**
 * Fixture teardown has to stop processes as well as delete directories, and it has to do it before the
 * directory goes away: the path IS the handle. The probe below is bounded on purpose - a fix for leaks
 * must not become the next leak, so the test never depends on the code under test to end it.
 */
describe('fixture teardown', { timeout: 120_000 }, () => {
  it('kills a process still running out of the fixture root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-do-gates-'));
    ROOTS.push(root);
    const marker = join(root, 'probe');
    const child = spawn('bash', ['-c', 'while :; do sleep 1; done', marker]);
    try {
      await once(child, 'spawn');
      await new Promise((done) => setTimeout(done, 1_500)); // agent-do-94t: 250ms starved under load
      const pids = () => spawnSync('pgrep', ['-f', '--', `${root}/`], { encoding: 'utf8' }).stdout.trim();
      expect(pids(), 'the probe must be visible to the same match teardown uses').not.toBe('');

      expect(reapFixtureProcesses(root)).toBeGreaterThan(0);
      expect(pids(), 'teardown must leave nothing matching the fixture root').toBe('');
      const exited = await Promise.race([
        once(child, 'exit').then(() => true),
        new Promise((done) => setTimeout(() => done(false), 10_000)), // agent-do-94t: 2s starved under load
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
      const deadline = Date.now() + 15_000; // agent-do-94t: 3s starved under load (run D, 705a26f)
      while (!existsSync(childPidFile) && Date.now() < deadline) sleepSync(50);
      const grandchild = readFileSync(childPidFile, 'utf8').trim();
      const alive = () => spawnSync('kill', ['-0', grandchild]).status === 0;
      expect(grandchild, 'the probe must record its rootless child').toMatch(/^\d+$/);
      expect(alive(), 'the rootless child must be running before teardown').toBe(true);

      expect(reapFixtureProcesses(root), 'both the matched process and its descendant').toBeGreaterThan(1);
      const gone = Date.now() + 10_000; // agent-do-94t: 2s starved under load
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
      await new Promise((done) => setTimeout(done, 1_500)); // agent-do-94t: 300ms starved under load
      expect(
        spawnSync('pgrep', ['-f', '--', `${root}/`], { encoding: 'utf8' }).stdout.trim(),
        'the probe must be matched before teardown',
      ).not.toBe('');

      expect(reapFixtureProcesses(root)).toBeGreaterThan(1);
      // agent-do-94t: under load the TERM handler's pid-file write raced this read; poll bounded
      // (the intent is unchanged: the handler must have run and recorded its child).
      const wroteBy = Date.now() + 10_000;
      while (!existsSync(lateChildPidFile) && Date.now() < wroteBy) sleepSync(25);
      expect(existsSync(lateChildPidFile), 'the TERM handler must have run').toBe(true);
      const late = readFileSync(lateChildPidFile, 'utf8').trim();
      expect(late, 'the handler must record a pid').toMatch(/^\d+$/);
      const alive = () => spawnSync('kill', ['-0', late]).status === 0;
      const gone = Date.now() + 10_000; // agent-do-94t: 2s starved under load
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
  // which is the case a walk cannot reach. This runs on EVERY pass - the first one included, before anything
  // is known to have leaked, and every grace-period pass after the TERM - because by a later pass the parent
  // is usually gone and an empty argv match is exactly when cwd is the only handle left on a reparented
  // child. Guarding this on a non-empty argv match would silently reintroduce agent-do-51j.
  //
  // The cost is therefore paid per fixture root, not only when something leaked: one full /proc listing plus
  // a readlink per numeric entry, measured at ~2-3 ms on this machine (only entries belonging to the same
  // user are readable, so the readlink count is well under the size of /proc). The suite creates a few dozen
  // roots per run, so a whole run pays tens of milliseconds - including a green run, which is the point:
  // this is the price of not having a hole, and it is far smaller than the cost of a leaked process, which
  // the reaper did not catch for two hours. agent-do-fhn: the previous wording claimed this was only
  // reached once something had matched, which is not what the code did.
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
  // agent-do-94t: the default 10s hookTimeout flaked the WHOLE FILE (35/35 tests passing) under VM load:
  // reaping ~10 fixture roots (/proc walks + a 1s settle each) plus recursive rmSync does not fit in 10s
  // on a contended 2-vCPU machine. The reaper's own 1s settle stays — it escalates to KILL and is bounded.
}, 120_000);

/** A throwaway checkout with this repo's tools/ and a tiny fixture of its own. */
function fixture(opts: { map?: string; stub?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agent-do-gates-'));
  ROOTS.push(root);
  const repo = join(root, 'repo');
  // Stubs are written below, after the repo exists (they are launched with it as their cwd).
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

  // Stub runner: records every suite it was asked for and writes the report the gate expects, or claims failure
  // when STUB_FAIL=1. See stubBody() for why it must write a report at all.
  const log = join(root, 'run.log');
  const stub = join(root, 'stub-runner');
  writeFileSync(stub, opts.stub ?? stubBody(), { mode: 0o755 });
  return { root, repo, log, stub };
}

/**
 * The stub runner's body. The gate invokes the runner ONCE with every selected suite plus
 * `--reporter=json --outputFile=<path>`, so a stub must record the suites (the file arguments, never the flags)
 * and write the report the gate maps back onto them. A stub that writes no report is not "fine": the gate then
 * reports every selected suite failed, which is the behaviour one of the cases below pins on purpose.
 *
 * `omit` leaves a suite out of the report; `extra` runs before the report is written (a stub that hangs, or that
 * leaves a descendant behind, never reaches it). The stub reads STUB_EXIT_CODE and STUB_SUCCESS so it can
 * DISAGREE with its own report: a failing global setup or teardown leaves every file green and appears only in the
 * exit code or in the report-wide verdict, which is the shape agent-do-kbi found being read as a pass.
 */
function stubBody({ omit = '', extra = '' }: { omit?: string; extra?: string } = {}): string {
  return [
    '#!/usr/bin/env bash',
    'report=""',
    'suites=()',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    --outputFile=*) report="${1#--outputFile=}" ;;',
    '    --*) ;;',
    '    *) suites+=("$1") ;;',
    '  esac',
    '  shift',
    'done',
    'printf \'%s\\n\' "${suites[@]}" >> "$RUN_LOG"',
    extra,
    'status=passed',
    'rc=0',
    '[ "${STUB_FAIL:-0}" = 1 ] && { status=failed; rc=1; }',
    '[ -n "${STUB_EXIT_CODE:-}" ] && rc=$STUB_EXIT_CODE',
    'success=$([ "$rc" = 0 ] && echo true || echo false)',
    '[ -n "${STUB_SUCCESS:-}" ] && success=$STUB_SUCCESS',
    'if [ -n "$report" ]; then',
    '  { printf \'{"success":%s,"testResults":[\' "$success"',
    '    first=1',
    '    for s in "${suites[@]}"; do',
    '      [ "$s" = "' + omit + '" ] && continue',
    '      [ "$first" = 1 ] || printf \',\'',
    '      first=0',
    '      printf \'{"name":"%s/%s","status":"%s","assertionResults":[{"status":"%s"}]}\' "$PWD" "$s" "$status" "$status"',
    '    done',
    '    printf \']}\'',
    '  } >"$report"',
    'fi',
    'exit $rc',
    '',
  ].join('\n');
}

type Run = { status: number | null; out: string };

function runGate(fx: ReturnType<typeof fixture>, args: string[], env: Record<string, string> = {}): Run {
  const r = spawnSync('bash', [join(fx.repo, 'tools', 'fast-gate.sh'), ...args], {
    cwd: fx.repo,
    encoding: 'utf8',
    timeout: 180_000, // agent-do-94t: 60s flaked to status=null (spawnSync kill) under VM load (run B, 705a26f)
    env: { ...process.env, FAST_GATE_RUNNER: fx.stub, STATIC_CMD: 'true', RUN_LOG: fx.log, ...env },
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * Read a `NAME=<number>` bound out of a conf file by ASKING THE SHELL THAT SOURCES IT, instead of parsing the text
 * (agent-do-3au6).
 *
 * Six reviews found six shapes a hand parser could not see - vw9 indentation/export/quotes/comments, 2lww command
 * terminators, dzjx expansion values, 3y0o stacked prefixes, b29z builtin prefixes (`declare`/`typeset`/`readonly`),
 * 3au6 `printf -v` / `read` / `eval`-assembled overrides - and each fix was another entry in a list. A guard whose
 * coverage IS a list has its bug in the list, so the list is gone. Two questions, both answered by bash:
 *
 *   1. WHAT value does the shell end up with? Source the file, then read the variable. The last assignment wins,
 *      expansions are really evaluated, and anything the shell refuses simply does not happen - exactly what the
 *      gate sees, because the gate sources this same file with this same shell.
 *   2. HOW MANY times was the key assigned? A keep-both-sides conflict must not quietly pick a side, so the count
 *      has to come from bash too. Two instruments, because bash lies in both directions here:
 *        - pre-declare the key `readonly`, then bash reports one `NAME: readonly variable` per assignment it would
 *          really perform. But that error ABORTS the rest of its command list, so `NAME=600; NAME=700` counts once.
 *        - `set -x`, which traces one line per command really run, so a same-line duplicate counts twice. But bash
 *          traces `export NAME=600` as two commands (the builtin and its assignment), so a lone export counts twice.
 *      Each blind spot is in the direction of the other instrument's strength, so the MAX of the two counts is what
 *      this uses; the export double-trace is de-duplicated explicitly (see countTraceAssignments) or every
 *      `export NAME=600` conf would read as a conflict.
 *
 * NaN (loud, via the caller's Number.isFinite pin) when the key is assigned anything other than exactly once, when
 * the conf silences an instrument (it turns tracing off, so the count is short by construction - agent-do-hgk7), or
 * when the value bash produces is not a bare integer: `600#note`, an expansion that resolves to nothing, a shell
 * that dies. Silence is never treated as agreement. And when in doubt this errs RED, never toward binding a number
 * nobody wrote: that one literal is what stands between a healthy loaded run and an UNKNOWN.
 *
 * What a conf redirecting its OWN stderr does NOT do is shorten the count, because the trace has its own fd
 * (agent-do-hgk7). That channel is vouched for by FACTS, not by mode checks (agent-do-qvlv): a per-call nonce is
 * written at both ends of the trace file and both marks must be IN THE FILE WE NAMED, and bash must still report
 * BASH_XTRACEFD=3 at the end. A conf that redirects the channel (`exec 3>/dev/null`) sends the end mark elsewhere and
 * is disowned; one that reassigns BASH_XTRACEFD is disowned by the variable check.
 *
 * The ceiling is stated rather than implied away, and it has two parts - both pinned by a test, both consequences of
 * the fact that a correct reading means EXECUTING the conf in the same shell (agent-do-yf46, agent-do-l7at):
 *
 *   - the COUNT: a conf that saves the trace fd and restores it around a redirect plus `exec 2>/dev/null` hides a
 *     duplicate from both instruments. Only the "assigned exactly once" advisory is lost, and only against a conf
 *     hiding its own work; the value is unaffected, so a window the gate does not use still reds the pin.
 *   - the VALUE: every forgery that arrives LATE - an exit trap writing to the open fd, a duplicate the conf saved
 *     first, a reopen through the path /proc/self/fd exposes - loses, because the mark is first-wins, the pipe has no
 *     path, and the shell closes both fds before it exits. What no ordering can stop is a conf that forges the mark
 *     DURING the source, before our own printf: to do that it must first read our per-call nonce out of its own
 *     process state, which nothing accidental does. That is the floor, and it is the price of the property this
 *     function exists for - reporting the window the shell really uses instead of the text it likes best.
 */
function readBound(conf: string, name: string): number {
  const dir = mkdtempSync(join(tmpdir(), 'readbound-'));
  // Paths are opened HERE and handed over as inherited FDs, never as arguments (agent-do-yf46). The conf is sourced in
  // the same shell as the instrument, so anything it can name it can rewrite: a `$3` trace path let a conf reopen the
  // channel it had redirected and let our own end mark vouch for a shortened trace, and a `$2` value path let an EXIT
  // trap overwrite the answer after we wrote it. An inherited fd has no name to name.
  const traceFile = join(dir, 'trace');
  const nonce = randomUUID();
  const traceFd = openSync(traceFile, 'w');
  try {
    const file = join(dir, 'check.conf');
    writeFileSync(file, conf);
    // One source answers three questions. The trace goes to fd 3 (BASH_XTRACEFD), which `exec 2>/dev/null` cannot touch,
    // so a conf silencing bash's diagnostics does not shorten the count (agent-do-hgk7). The trace is vouched for by two
    // facts, and an END mark exists only if BOTH held: bash was still tracing when the conf finished, and BASH_XTRACEFD
    // was still our fd. Absence of the mark is the failure signal, so nothing here can be deleted to look innocent.
    // The value leaves on fd 4 as a PIPE to this process, not a file: a pipe has no path, so /proc/self/fd/4 hands the
    // conf nothing it can reopen. Nonce mark, first one wins, and the shell closes both fds before it exits, so every
    // forgery that arrives late loses (agent-do-l7at).
    const sourced = spawnSync(
      'bash',
      [
        '-c',
        `BASH_XTRACEFD=3; printf 'BEGIN ${nonce}' >&3; set -x; . "$1"; ` +
          // Capture the voucher facts while tracing is still on, then stop tracing BEFORE writing the end mark - so the
          // mark can only be a line our own printf produced, never a traced rendering of the command that writes it.
          `v_xt=off; [ -o xtrace ] && v_xt=on; v_fd="\${BASH_XTRACEFD:-}"; set +x; ` +
          // One positive mark, written only if both vouchers held; a redirected or closed channel makes it fail silently.
          `{ [ "$v_xt" = on ] && [ "$v_fd" = 3 ] && printf '\nEND ${nonce}' >&3; } 2>/dev/null; ` +
          `printf '\nVALUE ${nonce} %s' "\${${name}-__unset__}" >&4; exec 4>&- 3>&-`,
        'readbound',
        file,
      ],
      // cwd is the throwaway directory, not the repo: a conf that redirects to a path it read out of /proc/self/fd
      // gets a name like `pipe:[12345]`, and bash would create that file in the CURRENT DIRECTORY. In the repo root it
      // is an untracked file that the next fast gate reports as an unmapped change - which is how this was found.
      { encoding: 'utf8', timeout: 10_000, cwd: dir, stdio: ['ignore', 'ignore', 'pipe', traceFd, 'pipe'] },
    );
    // The readonly-probe half of question 2, in a shell of its own so its deliberate errors cannot disturb the value.
    // Skipped when the trace already counted a second assignment: the answer is NaN either way, and this is the
    // common case in this suite, so duplicates cost one spawn instead of two.
    const trace = existsSync(traceFile) ? readFileSync(traceFile, 'utf8') : '';
    const traced = countTraceAssignments(trace, name);
    const probed = traced > 1
      ? { status: 0, stderr: '' }
      : spawnSync(
          'bash',
          ['-c', `${name}=__readbound; readonly ${name}; set +e; . "$1"`, 'readbound', file],
          { encoding: 'utf8', timeout: 10_000, cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] },
        );
    // `status === null` is the bound above killing a conf that blocks: UNKNOWN, so loud rather than a quiet number.
    if (sourced.status === null || probed.status === null) return NaN;
    // A conf that turned tracing off, or redirected the channel it goes to, shortens the trace to whatever ran before
    // it - an undercount by construction, exactly the shape that would let a duplicate read as "assigned once".
    // Unknown, so loud: both nonce marks must be in the trace, the opening one first (agent-do-qvlv).
    const endMarker = trace.indexOf(`END ${nonce}`);
    if (!trace.startsWith(`BEGIN ${nonce}`) || endMarker < 0) return NaN;
    const assignments = Math.max(
      traced,
      (probed.stderr ?? '').split(`${name}: readonly variable`).length - 1,
    );
    if (assignments !== 1) return NaN;
    // The value mark is nonce-tagged and the FIRST one wins, and the pipe is closed by the shell before it exits, so a
    // trap at exit, a saved duplicate of the fd and a reopen by /proc path all arrive too late (agent-do-l7at). What no
    // ordering can stop is a forgery DURING the source, before this printf runs - see the ceiling test.
    const valueText = String(sourced.output[4] ?? '');
    const valueMark = `VALUE ${nonce} `;
    const valueAt = valueText.indexOf(valueMark);
    // Only the line the mark introduces: anything a conf managed to append after it is a separate line and is ignored.
    const value = valueAt < 0 ? '__unset__' : (valueText.slice(valueAt + valueMark.length).split('\n')[0] ?? '');
    const literal = /^(\d+)$/.exec(value);
    return literal ? Number(literal[1]) : NaN;
  } finally {
    closeSync(traceFd);
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Count the traced commands that assign `name`, from a `set -x` trace of a sourced conf. Two bash renderings have to
 * be undone, both of which only ever over-count: PS4 (`+`, `++` when the source nests) is not part of the command,
 * and `export NAME=600` is traced as TWO commands (the export builtin, then its assignment), so the bare repeat that
 * follows an export of the same key is dropped. A genuine duplicate on separate lines traces twice with no export
 * line between them, so it still counts twice - which is what keeps a keep-both-sides conflict loud.
 */
function countTraceAssignments(trace: string, name: string): number {
  const assigns = new RegExp(`(^|[^A-Za-z0-9_])${name}=`);
  let count = 0;
  let afterExport = false; // the previous traced command was `export NAME=...`, whose assignment bash traces again
  for (const raw of trace.split('\n')) {
    const line = raw.replace(/^\++[ \t]*/, '').trim();
    if (line.startsWith(`export ${name}=`) || line.startsWith(`export ${name} =`)) {
      count += 1;
      afterExport = true;
    } else if (assigns.test(line)) {
      if (!afterExport) count += 1; // the second trace line of an export was already counted above
      afterExport = false;
    } else {
      afterExport = false;
    }
  }
  return count;
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

describe('tools/fast-gate.sh — affected-only selection', { timeout: 120_000 }, () => {
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

  it('never reports a suite as passed when the runner report does not mention it', () => {
    // The direction that has to stay pessimistic (fleet-1n0z). A report that covers only part of the selection
    // is exactly what a crashed or truncated run looks like, and a suite the report never named was not
    // demonstrated to have run, so it cannot be reported passed.
    const fx = fixture({ stub: stubBody({ omit: 'tests/b.test.ts' }) });
    const { status, out } = runGate(fx, ['--changed', 'src/a.ts']);
    expect(out).toContain('fast-gate: passed: tests/a.test.ts');
    expect(out).toContain('fast-gate: failed: tests/b.test.ts');
    expect(out).not.toContain('fast-gate: passed: tests/b.test.ts');
    expect(status).not.toBe(0);
  });

  it('reports every selected suite failed when the runner produces no report at all', () => {
    // No report, no node, an unreadable file: in every case nothing is proven, so nothing is green. The
    // batch-bound-kill shape is pinned separately below — a report-less kill is `unknown`, NOT a verdict
    // (agent-do-c45) — this case pins the non-kill causes, where the runner exited and still said nothing.
    const fx = fixture({ stub: '#!/usr/bin/env bash\nexit 0\n' });
    const { status, out } = runGate(fx, ['--changed', 'src/a.ts']);
    expect(out).toContain('fast-gate: failed: tests/a.test.ts');
    expect(out).toContain('fast-gate: failed: tests/b.test.ts');
    expect(out).not.toContain('fast-gate: passed:');
    expect(status).not.toBe(0);
  });

  it('reports every selected suite failed when the parse step produces nothing at all', () => {
    // The last line of defence. node parses the report; if that step yields no mapping - node missing or broken,
    // or a report nothing will read - the fallback reports every selected suite failed. A fallback that reported
    // passed would turn "the thing that reads the verdict is broken" into a green for every lane at once, so this
    // arm needs its own case: the two cases above never reach it, because the parser itself reports failed for a
    // suite its report does not name.
    const fx = fixture();
    const bin = join(fx.root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'node'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
    const { status, out } = runGate(fx, ['--changed', 'src/a.ts'], { PATH: `${bin}:${process.env.PATH ?? ''}` });
    expect(out).toContain('fast-gate: failed: tests/a.test.ts');
    expect(out).toContain('fast-gate: failed: tests/b.test.ts');
    expect(out).not.toContain('fast-gate: passed:');
    expect(status).not.toBe(0);
  });

  it('fails when the runner exits non-zero even though its report says every suite passed', () => {
    // The report and the exit code are two channels, and a failing global setup or teardown shows up only in the
    // second: every file can be green while the run as a whole is not trustworthy. This is the shape that matters
    // most - the previous version read the report alone, so it printed `fast-gate: PASS` and exited 0 here.
    const fx = fixture();
    // STUB_SUCCESS=true is the point of this case: the report claims a clean run in every field, so the ONLY
    // signal left is the runner's exit code. Without it the report channel would mask this one and the case would
    // pass even with the exit code ignored entirely - which is what a mutation check showed the first time.
    const { status, out } = runGate(fx, ['--changed', 'src/a.ts'], {
      STUB_EXIT_CODE: '1',
      STUB_SUCCESS: 'true',
    });
    expect(out).toContain('fast-gate: FAIL');
    expect(out).not.toContain('fast-gate: PASS');
    expect(out).toContain('runner exit 1');
    expect(status).not.toBe(0);
  });

  it('fails when the report itself reports an unsuccessful run', () => {
    // Same loss of trust, arriving through the report instead of the exit code: vitest can set success:false for
    // an unhandled error or a global failure while every file it lists says passed.
    const fx = fixture();
    const { status, out } = runGate(fx, ['--changed', 'src/a.ts'], { STUB_SUCCESS: 'false' });
    expect(out).toContain('fast-gate: FAIL');
    expect(out).not.toContain('fast-gate: PASS');
    expect(status).not.toBe(0);
  });

  it('lists the selection without running anything', () => {
    const fx = fixture();
    const { status, out } = runGate(fx, ['--list', '--changed', 'src/a.ts']);
    expect(out).toContain('tests/a.test.ts');
    expect(readLog(fx)).toEqual([]);
    expect(status).toBe(0);
  });

  // Spawns two real gate runs, each of which forks bash and node: the cost is the machine's, not the
  // assertion's, so it must not be measured against vitest's 5 s default (agent-do-c26).
  it('refuses to guess when the map is missing, and when a mapped suite does not exist', { timeout: 60_000 }, () => {
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

describe('tools/fast-gate.sh — a batch-bound kill with no report is unknown, not a false red (agent-do-c45)', { timeout: 120_000 }, () => {
  // SUITE_BOUND=1 against a stub that sleeps past it drives the REAL kill path — `timeout -k 15` TERMs the
  // runner, the batch records exit 124, no report exists — no mocks, and it settles in about a second.
  it('reports unknown, names the batch bound, prints no per-suite result, and exits with the kill code', () => {
    const fx = fixture({ stub: '#!/usr/bin/env bash\nsleep 30\n' });
    const { status, out } = runGate(fx, ['--changed', 'src/a.ts'], { SUITE_BOUND: '1' });
    expect(out).toContain('fast-gate: unknown: the 1s batch bound killed the run before any suite reported');
    expect(out).not.toContain('fast-gate: failed:');   // zero assertions ran; naming suites failed is a lie
    expect(out).not.toContain('fast-gate: passed:');
    expect(out).toContain('fast-gate: UNKNOWN - NOT a verdict');
    expect(out).toContain('runner exit 124');          // the run log tail still prints for the wedged-suite hunt
    expect(status).toBe(124);                          // fleet-check records 124/137/143 as KILLED, never FAIL
  });

  it('still reports the per-suite evidence when the kill landed after a report was written', () => {
    // The boundary of the arm above: a report that EXISTS is evidence, so its statuses print and the kill
    // keeps the run untrusted (FAIL) rather than swallowing them into an unknown.
    const fx = fixture({ stub: stubBody().replace('exit $rc', 'sleep 30\nexit $rc') });
    const { status, out } = runGate(fx, ['--changed', 'src/a.ts'], { SUITE_BOUND: '1' });
    expect(out).toContain('fast-gate: passed: tests/a.test.ts');
    expect(out).toContain('fast-gate: passed: tests/b.test.ts');
    expect(out).toContain('the run is not trustworthy');
    expect(out).toContain('fast-gate: FAIL');
    expect(status).toBe(1);
  });
});

describe('tools/fast-gate.sh — kill windows', { timeout: 120_000 }, () => {
  it('derives the batch bound from the outer window, and the config files agree', () => {
    // A per-suite bound that is not below the outer window is a race: whichever fires first decides. Since
    // agent-do-c45 both outcomes read `unknown` — but the outer kill prints its marker and stops, losing the
    // run log, while the batch bound prints the log tail: the evidence for WHICH suite wedged. That tail is
    // what this relationship protects. It is asserted here rather than left to a comment, so raising one of
    // the bounds alone goes red.
    //
    // agent-do-cj6/gmr: the EFFECTIVE bound is what must relate to the outer window. A constant reserve
    // (cj6's `SUITE_BOUND=880` env prefix in CHECK_FAST_CMD = outer minus a guessed 80 s) was wrong by
    // 1-3x against the measured warm static step (58.7 s no-op, 220.4 s partial rebuild), so the OUTER
    // window fired first and healthy loaded runs recorded `unknown`. fast-gate.sh now derives the bound
    // after MEASURING the static step. Pinned here: (a) the two config files agree on the window —
    // gate.conf's FAST_OUTER_WINDOW is the only channel the script has, because fleet-check does not
    // export CHECK_FAST_TIMEOUT to the command; (b) CHECK_FAST_CMD stays the bare `bash <path>` form —
    // an env-prefix hides the gate path from fleet-check's missing-target preflight (agent-do-a2t: a
    // config naming a nonexistent gate then burns a heavy slot instead of being refused); (c) the
    // derivation formula exists; (d) the fallback default still fits inside the window with its kill
    // grace.
    const gate = readFileSync(join(REPO, 'tools', 'fast-gate.sh'), 'utf8');
    const conf = readFileSync(join(REPO, 'tools', 'check.conf'), 'utf8');
    const gconf = readFileSync(join(REPO, 'tools', 'gate.conf'), 'utf8');
    const outer = readBound(conf, 'CHECK_FAST_TIMEOUT');
    const declared = readBound(gconf, 'FAST_OUTER_WINDOW');
    expect(Number.isFinite(outer), 'CHECK_FAST_TIMEOUT must appear exactly once as a literal number in tools/check.conf (a duplicated key is a keep-both-sides conflict: bash runs the LAST, agent-do-0yl)').toBe(true);
    expect(declared, 'FAST_OUTER_WINDOW in tools/gate.conf must appear exactly once and mirror CHECK_FAST_TIMEOUT (fleet-check does not export it; agent-do-gmr; last-wins/once: agent-do-0yl)').toBe(outer);
    const cmd = /^CHECK_FAST_CMD='([^']*)'$/m.exec(conf)?.[1];
    expect(cmd, "CHECK_FAST_CMD must stay the bare bash form so fleet-check's missing-target preflight sees the gate path (agent-do-a2t)").toBe('bash tools/fast-gate.sh');
    expect(gate, 'the batch bound must be derived from the MEASURED static step (agent-do-gmr)').toMatch(/SUITE_BOUND=\$\(\( FAST_OUTER_WINDOW - static_secs - _margin \)\)/);
    const fallback = Number(/^SUITE_BOUND=\$\{SUITE_BOUND:-(\d+)\}/m.exec(gate)?.[1]);
    expect(Number.isFinite(fallback), 'the no-window fallback must stay a literal number in tools/fast-gate.sh').toBe(true);
    // 15 s is the SIGKILL grace the runner is given (`timeout -k 15`): even the fallback must be able to
    // fire, escalate, and still leave the gate time to name the suite before the outer window ends.
    expect(fallback + 15).toBeLessThan(outer);
  });

  it('pins the FULL gate window at or above 2x the worst healthy full-gate measurement (agent-do-yuc)', () => {
    // Nothing else in tests/ reads CHECK_TIMEOUT: the full gate has no inner window of its own, so this one
    // literal is all that stands between a healthy loaded run and an UNKNOWN. It has gone silently wrong
    // twice (agent-do-v3m: 600 s against a 563 s worst healthy row — 94% of the window — and it fired twice
    // on one tree; agent-do-ewz: the installed conf sat at 600 s while the repo said 1200 s). A floor makes
    // lowering it a red test that names the measurement instead of a load-dependent kill. When the speed.md
    // §4 lever lands and the full gate gets genuinely faster, lower this floor AND tools/check.conf together
    // (speed.md R4: re-measure and tighten).
    const conf = readFileSync(join(REPO, 'tools', 'check.conf'), 'utf8');
    const full = readBound(conf, 'CHECK_TIMEOUT');
    expect(Number.isFinite(full), 'CHECK_TIMEOUT must appear exactly once as a literal number in tools/check.conf (a duplicated key is a keep-both-sides conflict: bash runs the LAST assignment while a first-match parse pins the first — agent-do-0yl)').toBe(true);
    // 563 s = the worst healthy full-gate observation recorded in docs/speed.md §4 and tools/check.conf's
    // prose (measured 2026-10-22); the 2× ratio is the v3m precedent ("2x the window that fired").
    expect(
      full,
      'CHECK_TIMEOUT must stay >= 2x the worst healthy full-gate row (563 s) — at 94% of the window (v3m) it fired twice on healthy runs; if the §4 lever made the full gate faster, lower this floor and the conf together (speed.md R4)',
    ).toBeGreaterThanOrEqual(1126);
    // The full tier runs a strict superset of the fast tier (R2), so its kill window cannot be smaller.
    const fast = readBound(conf, 'CHECK_FAST_TIMEOUT');
    expect(Number.isFinite(fast), 'CHECK_FAST_TIMEOUT must appear exactly once as a literal number in tools/check.conf (a duplicated key is a keep-both-sides conflict: bash runs the LAST, agent-do-0yl)').toBe(true);
    expect(full, 'the full gate\'s kill window must not be smaller than the fast tier\'s (R2: fast is a strict subset of full)').toBeGreaterThanOrEqual(fast);
  });

  it('derives the batch bound at runtime: outer window minus measured static minus margin (agent-do-gmr)', () => {
    const fx = fixture();
    const hang = join(fx.root, 'hang-runner');
    writeFileSync(hang, '#!/usr/bin/env bash\nsleep 60\n', { mode: 0o755 });
    // window 14, margin 2, floor 2, static `sleep 1` -> derived bound 11 (10 if the clock ticks during
    // spawn). The runner hangs, so the derived bound must fire, report unknown (NOT per-suite failed,
    // agent-do-c45), and exit with the kill code.
    const r = runGate(fx, ['--changed', 'src/a.ts'], {
      FAST_GATE_RUNNER: hang,
      STATIC_CMD: 'sleep 1',
      FAST_OUTER_WINDOW: '14',
      FAST_GATE_STATIC_MARGIN: '2',
      FAST_GATE_BOUND_FLOOR: '2',
    });
    const out = r.out;
    expect(out, 'the derivation must announce itself with the numbers it used').toMatch(/batch bound (?:10|11)s = 14s outer - [12]s static - 2s margin/);
    expect(out).toMatch(/^fast-gate: unknown: the (?:10|11)s batch bound killed the run before any suite reported/m);
    expect(r.status, 'a batch-bound kill exits with the kill code, recorded KILLED (agent-do-c45)').toBe(124);
    expect(out, 'a report-less kill must not name suites as failed').not.toMatch(/^fast-gate: failed:/m);
  }, 60_000);
});

describe('readBound — a duplicated bound cannot hide behind a shape bash honours (agent-do-vw9, agent-do-dzjx)', { timeout: 120_000 }, () => {
  // Every LEFT value below is a file bash would source successfully: each of these assignment shapes was run
  // through `bash -c 'source ./c.conf; echo $CHECK_TIMEOUT'` and printed the assigned value, i.e. a keep-both-sides
  // resolution or a stray edit that produced one of them would really change the gate's window while the pin above
  // stayed green. The guard's contract is "exactly one ASSIGNMENT", so each of these must read as NaN (duplicated)
  // rather than as a value - including the ones whose value is an expansion, where there is nothing to read but
  // the fact that the key is set twice.
  const duplicated: [string, string][] = [
    ['a verbatim second assignment', 'CHECK_TIMEOUT=600\nCHECK_TIMEOUT=600\n'],
    ['a space-indented second assignment', 'CHECK_TIMEOUT=600\n  CHECK_TIMEOUT=600\n'],
    ['a tab-indented second assignment', 'CHECK_TIMEOUT=600\n\tCHECK_TIMEOUT=600\n'],
    ['an export-prefixed second assignment', 'CHECK_TIMEOUT=600\nexport CHECK_TIMEOUT=600\n'],
    ['an indented export-prefixed second assignment', 'CHECK_TIMEOUT=600\n  export   CHECK_TIMEOUT=600\n'],
    ['a double-quoted second assignment', 'CHECK_TIMEOUT=600\nCHECK_TIMEOUT="600"\n'],
    ['a single-quoted second assignment', "CHECK_TIMEOUT=600\nCHECK_TIMEOUT='600'\n"],
    ['a second assignment with a trailing comment', 'CHECK_TIMEOUT=600\nCHECK_TIMEOUT=600  # keep both sides\n'],
    ['a second assignment carrying a conflict marker', 'CHECK_TIMEOUT=600\nCHECK_TIMEOUT=600 # >>>>>>> fleet/imp-1\n'],
    ['the duplicate written first and the plain one last', '  export CHECK_TIMEOUT=1800\nCHECK_TIMEOUT=600\n'],
    // agent-do-2lww: a command terminator is not part of the value, so `NAME=600;` is an assignment of 600.
    ['a semicolon-terminated second assignment', 'CHECK_TIMEOUT=600\nCHECK_TIMEOUT=600;\n'],
    ['a semicolon-terminated second assignment with a comment', 'CHECK_TIMEOUT=600\nCHECK_TIMEOUT=600;  # keep both sides\n'],
    ['two assignments on one command line', 'CHECK_TIMEOUT=600;CHECK_TIMEOUT=600\n'],
    ['a semicolon-joined export duplicate', 'CHECK_TIMEOUT=600; export CHECK_TIMEOUT=600\n'],
    ['duplicates joined with &&', 'CHECK_TIMEOUT=600&&CHECK_TIMEOUT=600\n'],
    // A backgrounded first assignment (`&`) does not survive into the parent shell, so bash keeps only the
    // second here; counting both errs on the loud side, which is the right direction for a guard.
    ['duplicates joined with a background &', 'CHECK_TIMEOUT=600&CHECK_TIMEOUT=600\n'],
    // agent-do-dzjx: the count is of ASSIGNMENTS, not of readable numbers. An expansion is still an assignment, and
    // bash runs it, so a literal followed by one of these is a duplicated key that used to count once and bind the
    // literal while the shell used the other value.
    ['an arithmetic expansion duplicate', 'CHECK_TIMEOUT=1800\nCHECK_TIMEOUT=$((600))\n'],
    ['a parameter expansion duplicate', 'CHECK_TIMEOUT=1800\nCHECK_TIMEOUT=${WINDOW}\n'],
    ['a command substitution duplicate', 'CHECK_TIMEOUT=1800\nCHECK_TIMEOUT=$(date +%s)\n'],
    ['an expansion duplicate on the same line', 'CHECK_TIMEOUT=1800; CHECK_TIMEOUT=$((600))\n'],
    ['a guard-shortcircuit duplicate', 'CHECK_TIMEOUT=1800\nfalse || CHECK_TIMEOUT=600\n'],
    ['an if-guarded duplicate', 'CHECK_TIMEOUT=1800\nif true; then CHECK_TIMEOUT=600; fi\n'],
    // A pipeline runs each side in a subshell, so bash leaves the parent's value UNSET here and only the count
    // (two assignments seen) is what fires; like the `&` case above this errs toward a red, never a quiet bind.
    ['a pipe-separated duplicate', 'CHECK_TIMEOUT=1800 | CHECK_TIMEOUT=600\n'],
    // agent-do-3y0o: prefixes stack, and the previous list allowed only one of them, so `then export NAME=600` hid a
    // duplicate one keyword deeper than the shape that had just been fixed.
    ['a then-export duplicate', 'CHECK_TIMEOUT=1800\nif true; then export CHECK_TIMEOUT=600; fi\n'],
    ['an else-export duplicate', 'CHECK_TIMEOUT=1800\nif false; then CHECK_TIMEOUT=900; else export CHECK_TIMEOUT=600; fi\n'],
    ['a declare duplicate', 'CHECK_TIMEOUT=1800\ndeclare CHECK_TIMEOUT=600\n'],
    ['a readonly duplicate', 'CHECK_TIMEOUT=1800\nreadonly CHECK_TIMEOUT=600\n'],
    ['a negated-command duplicate', 'CHECK_TIMEOUT=1800\n! CHECK_TIMEOUT=600\n'],
    // agent-do-b29z: the remaining members of that same prefix family, plus one shape NO prefix list can enumerate (a
    // `case` branch). Each left value below was sourced by bash and printed 600 over the 1800, so every one of them
    // really moves the gate window; the last two are only readable because rule 2 fails closed on live text it cannot
    // parse, which is what makes the list stop being the bug. (`local` is not here: bash rejects it outside a
    // function, so it is not a shape a sourced conf can carry.)
    ['a typeset duplicate', 'CHECK_TIMEOUT=1800\ntypeset CHECK_TIMEOUT=600\n'],
    ['an indented declare duplicate', 'CHECK_TIMEOUT=1800\n   declare  CHECK_TIMEOUT=600\n'],
    ['an elif-declare duplicate', 'CHECK_TIMEOUT=1800\nif false; then :; elif true; then declare CHECK_TIMEOUT=600; fi\n'],
    ['a case-branch duplicate', 'CHECK_TIMEOUT=1800\ncase x in x) CHECK_TIMEOUT=600;; esac\n'],
    // Counted although this loop never runs, so bash would keep 1800: the guard does not model control flow, and
    // the count is the conservative reading (`while false; do NAME=600; done` alone leaves bash with no value).
    // agent-do-3au6: the three shapes that ended the shape chase. Each one sets the key a second time without ever
    // writing `NAME=` as shell TEXT, so a reader that looks for that text (or for a prefix in front of it) cannot
    // count them at all - `printf -v` names the key as an argument, `read` fills it, and `eval` assembles the
    // assignment from a string. bash counts every one of them, so the pin stays loud.
    ['a printf-v duplicate', 'CHECK_TIMEOUT=1800\nprintf -v CHECK_TIMEOUT %s 600\n'],
    ['a read-builtin duplicate', 'CHECK_TIMEOUT=1800\nread CHECK_TIMEOUT <<< 600\n'],
    ['an eval-assembled duplicate', 'CHECK_TIMEOUT=1800\nX=CHECK; eval "${X}_TIMEOUT=600"\n'],
    // A live mention that is NOT an assignment is still loud when a real assignment sits beside it: bash traces the
    // echo as a command naming the key, so the count is two and the reader refuses to choose. (The old rule-2 note
    // claimed this for every unreadable mention; what it actually rests on is the count, which is the honest claim.)
    ['an unreadable live mention', 'CHECK_TIMEOUT=1800\necho CHECK_TIMEOUT=600\n'],
    // agent-do-hgk7: a conf that silences an instrument must not thereby read as "assigned once". A stderr redirect no
    // longer touches the count at all (the trace has its own fd), and turning tracing off or closing that fd is
    // reported as unknown rather than trusted as a short trace.
    ['a duplicate behind a stderr redirect', 'CHECK_TIMEOUT=1800\nexec 2>/dev/null\nCHECK_TIMEOUT=600\n'],
    ['a duplicate once tracing is off', 'CHECK_TIMEOUT=1800; set +x; CHECK_TIMEOUT=600\n'],
    ['a duplicate once the trace fd is closed', 'exec 3>&-\nCHECK_TIMEOUT=1800\nCHECK_TIMEOUT=600\n'],
    // agent-do-qvlv: and closing the channel is not the only way to silence it - REDIRECTING it leaves the fd open,
    // and reassigning BASH_XTRACEFD leaves our variable to check. Both are disowned by the vouchers, so both read NaN.
    ['a duplicate behind a redirected trace fd', 'CHECK_TIMEOUT=1800\nexec 2>/dev/null\nexec 3>/dev/null\nCHECK_TIMEOUT=600\n'],
    ['a duplicate behind a reassigned BASH_XTRACEFD', 'CHECK_TIMEOUT=1800\nexec 2>/dev/null\nexec 9>/dev/null\nBASH_XTRACEFD=9\nCHECK_TIMEOUT=600\n'],
    // agent-do-yf46: the conf shares a process with the instrument, so the vouchers may not be anything it can DELETE or
    // any path it can NAME. There is no flag file to remove, no trace path to reopen, and the end mark is positive.
    ['a duplicate with the flag file removed by an EXIT trap', 'CHECK_TIMEOUT=1800\nexec 2>/dev/null\nset +x\nCHECK_TIMEOUT=600\ntrap \'rm -f "$4"\' EXIT\n'],
    ['a duplicate with the flag file removed by a DEBUG trap', 'CHECK_TIMEOUT=1800\nexec 2>/dev/null\nset +x\nCHECK_TIMEOUT=600\ntrap \'rm -f "$4"\' DEBUG\n'],
    ['a duplicate behind a trace channel reopened by path', 'CHECK_TIMEOUT=1800\nexec 2>/dev/null\nexec 3>/dev/null\nCHECK_TIMEOUT=600\nexec 3>>"$3"\n'],
  ];

  it.each(duplicated)('reports NaN for %s', (_label, conf) => {
    expect(
      Number.isFinite(readBound(conf, 'CHECK_TIMEOUT')),
      `readBound read a single value out of a file with two assignments bash would both run:\n${conf}`,
    ).toBe(false);
  });

  it('reads each shape on its own, so the hardening does not turn a valid conf into a false red', () => {
    for (const one of [
      'CHECK_TIMEOUT=600\n',
      '  CHECK_TIMEOUT=600\n',
      'export CHECK_TIMEOUT=600\n',
      'CHECK_TIMEOUT="600"\n',
      'CHECK_TIMEOUT=600  # measured 2026-10-22\n',
      'CHECK_TIMEOUT=600;\n',
      'CHECK_TIMEOUT=600;  # a terminator and a note\n',
      'export CHECK_TIMEOUT=600;\n',
      '  CHECK_TIMEOUT="600";  # quoted, terminated, annotated\n',
      // One assignment is one assignment, however it is reachable: these are all files where bash ends up with
      // 600 and nothing else assigns the key, so a red here would be a false alarm.
      'if true; then CHECK_TIMEOUT=600; fi\n',
      'false || CHECK_TIMEOUT=600\n',
      // agent-do-b29z: a declare/typeset prefix is one assignment, like `export`, so the hardening above must not
      // turn the prefixes the fix added into a false red on a conf that legitimately uses them.
      'declare CHECK_TIMEOUT=600\n',
      'typeset CHECK_TIMEOUT=600\n',
      // agent-do-3au6: and the shapes bash renders in its own way. `export NAME=600` is traced as two commands (the
      // builtin and its assignment), which is the one place the trace over-counts - so a lone export must stay
      // readable, and an indirect assignment with no duplicate must too.
      'export CHECK_TIMEOUT=600\n',
      'printf -v CHECK_TIMEOUT %s 600\n',
      // agent-do-hgk7: and a conf redirecting its OWN stderr still reads, because the trace does not use stderr.
      'exec 2>/dev/null\nCHECK_TIMEOUT=600\n',
    ]) {
      expect(readBound(one, 'CHECK_TIMEOUT'), `a single assignment must stay readable: ${JSON.stringify(one)}`).toBe(600);
    }
  });

  it('does not count a commented-out or differently-named assignment as the key', () => {
    expect(readBound('# CHECK_TIMEOUT=600\nCHECK_TIMEOUT=1800\n', 'CHECK_TIMEOUT')).toBe(1800);
    expect(readBound('CHECK_FAST_TIMEOUT=600\nCHECK_TIMEOUT=1800\n', 'CHECK_TIMEOUT')).toBe(1800);
    expect(readBound('CHECK_TIMEOUT_SUFFIX=600\nCHECK_TIMEOUT=1800\n', 'CHECK_TIMEOUT')).toBe(1800);
    // A commented-out override is not an assignment, even when it carries a terminator of its own.
    expect(readBound('CHECK_TIMEOUT=1800\n# CHECK_TIMEOUT=600; CHECK_TIMEOUT=700\n', 'CHECK_TIMEOUT')).toBe(1800);
    // ...but a live shell mention of the key that is not an assignment is no longer ignored: it is unreadable, and
    // an unreadable file reads as NaN. Before agent-do-3y0o this returned 1800 by silently skipping the segment,
    // which is the same "skip what you do not understand" habit that let every previous shape through.
    expect(Number.isFinite(readBound('echo "CHECK_TIMEOUT=600"\nCHECK_TIMEOUT=1800\n', 'CHECK_TIMEOUT'))).toBe(false);
  });

  it('never resolves a value it cannot read, and never lets a second assignment pass (documented contract)', () => {
    // `NAME=600#note` is a string in bash, so it is not a bound; an expansion that resolves to nothing is not one
    // either. Both go NaN, so the caller's Number.isFinite pin goes red instead of binding a number nobody wrote.
    expect(Number.isFinite(readBound('CHECK_TIMEOUT=600#note\n', 'CHECK_TIMEOUT'))).toBe(false);
    expect(Number.isFinite(readBound('CHECK_TIMEOUT=${WINDOW}\n', 'CHECK_TIMEOUT'))).toBe(false);
    // An expansion that DOES resolve is read, because bash resolves it (agent-do-3au6): `$((30 * 60))` is 1800 in
    // the shell the gate sources this file with, so returning NaN here was a false red on a legitimate conf. The
    // number is no longer guessed from the text - it is what the shell computes.
    expect(readBound('CHECK_TIMEOUT=$((30 * 60))\n', 'CHECK_TIMEOUT')).toBe(1800);
    // ...and an unreadable assignment is still counted as an assignment: with a literal alongside it the key is set
    // twice, so this is NaN rather than the literal 1800. Before agent-do-dzjx this line returned 1800 - which is
    // exactly the false green, because bash runs the expansion last.
    expect(Number.isFinite(readBound('CHECK_TIMEOUT=$((600))\nCHECK_TIMEOUT=1800\n', 'CHECK_TIMEOUT'))).toBe(false);
    // Control flow is not modelled by hand either, because bash is the oracle: an assignment in a branch that never
    // runs is not an assignment, so this reads the 1800 the shell keeps rather than a conflict that does not exist.
    expect(readBound('CHECK_TIMEOUT=1800\nwhile false; do CHECK_TIMEOUT=600; done\n', 'CHECK_TIMEOUT')).toBe(1800);
    // Silence is never agreement (agent-do-hgk7): a conf that turns tracing off leaves a trace that is short BY
    // CONSTRUCTION, so even its single visible assignment is unreadable - the count cannot be vouched for.
    expect(Number.isFinite(readBound('set +x\nCHECK_TIMEOUT=600\n', 'CHECK_TIMEOUT'))).toBe(false);
  });

  it('pins the ceiling, which is about the COUNT only: a late forgery cannot move the value', () => {
    // agent-do-yf46 and agent-do-l7at asked for the residual to be measured and stated rather than implied away, so it
    // is pinned here. The conf is sourced IN THE SAME SHELL as the instrument, which means two different limits:
    //
    //   1. the COUNT can be shortened: a conf that saves our trace fd and restores it around a redirect is invisible to
    //      any post-hoc check. Only the "assigned exactly once" advisory is lost, and only against a conf hiding its own
    //      work. The VALUE is unaffected, so the FULL-window pin is still red for any window the gate does not use.
    expect(readBound('CHECK_TIMEOUT=1800\nexec 2>/dev/null\nexec 5>&3\nexec 3>/dev/null\nCHECK_TIMEOUT=600\nexec 3>&5\n', 'CHECK_TIMEOUT')).toBe(600);
    //   2. the VALUE channel resists everything that arrives LATE - and that is a tested property, not a hope: the mark
    //      is first-wins, the fd is closed by the shell before it exits, and the value leaves on a pipe, which has no
    //      path for /proc/self/fd to give back. These three shapes each try to append a winning mark after ours
    //      (agent-do-l7at): through the open fd from an exit trap, through a duplicate the conf saved first, and through
    //      the path read out of /proc/self/fd.
    const nonceFromProc = String.raw`_n=$(tr '\0' '\n' < /proc/$$/cmdline | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)`;
    expect(readBound(`CHECK_TIMEOUT=600\n${nonceFromProc}\ntrap 'printf "\\nVALUE $_n 9999" >&4' EXIT\n`, 'CHECK_TIMEOUT')).toBe(600);
    expect(readBound(`CHECK_TIMEOUT=600\nexec 5>&4\n${nonceFromProc}\ntrap 'printf "\\nVALUE $_n 9999" >&5' EXIT\n`, 'CHECK_TIMEOUT')).toBe(600);
    expect(readBound(`CHECK_TIMEOUT=600\nexec 5>&4\n_p=$(readlink /proc/self/fd/5)\n${nonceFromProc}\ntrap 'printf "\\nVALUE $_n 9999" >"$_p"' EXIT\n`, 'CHECK_TIMEOUT')).toBe(600);
    // What is NOT claimed, and cannot be while a correct reading means executing the conf: a conf that forges the mark
    // DURING the source, before our own printf, wins - it is first. It has to read our nonce out of its own process
    // state to do it, which nothing accidental does. This assertion documents that floor so no later change, and no
    // review, has to rediscover it. It is the price of the property the reader is FOR: the window it reports is the one
    // the shell really uses.
    expect(readBound(`CHECK_TIMEOUT=600\n${nonceFromProc}\nprintf "\\nVALUE $_n 9999" >&4\n`, 'CHECK_TIMEOUT')).toBe(9999);
  });

  it('still finds exactly one of each key in the conf files this repo actually ships', () => {
    for (const [file, name] of [
      ['check.conf', 'CHECK_TIMEOUT'],
      ['check.conf', 'CHECK_FAST_TIMEOUT'],
      ['gate.conf', 'FAST_OUTER_WINDOW'],
    ] as const) {
      const text = readFileSync(join(REPO, 'tools', file), 'utf8');
      expect(Number.isFinite(readBound(text, name)), `${name} must appear exactly once in tools/${file}`).toBe(true);
    }
  });
});

describe('tools/fast-gate.sh — the runner gets a worker count (agent-do-664)', () => {
  // The bug this pins is the shape, not a value: `FAST_GATE_JOBS` was declared, defaulted and documented
  // in the script for months while nothing passed it to the runner, so every suite ran on one fork on a
  // 2-vCPU VM and the fast tier could not finish inside its own kill window. A text assertion is weak on
  // purpose here — the alternative is spawning a gate to observe vitest's argv, which costs a gate run to
  // prove a string is wired up.
  const gate = readFileSync(join(REPO, 'tools', 'fast-gate.sh'), 'utf8');

  it('builds --maxWorkers from FAST_GATE_JOBS', () => {
    expect(gate).toMatch(/WORKERS_ARG="--maxWorkers=\$JOBS"/);
  });

  it('passes it to the runner on BOTH paths, the setsid one and the fallback', () => {
    expect(gate).toMatch(/\$RUNNER \$WORKERS_ARG/);
    expect(gate).toMatch(/\$FAST_GATE_RUNNER \$WORKERS_ARG/);
  });

  it('stays silent for an explicitly empty FAST_GATE_JOBS, so a non-vitest runner is possible', () => {
    expect(gate).toMatch(/^\s*''\) ;;$/m);
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

  // Scans the whole test tree; ~3.5 s on an idle 2-vCPU VM and over the 5 s default once the VM is busy
  // (agent-do-c26).
  it('is in sync with the test import graph (node tools/gen-suite-map.mjs --check)', { timeout: 60_000 }, () => {
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
describe('tools/fast-gate.sh — cleanup when the run is killed', { timeout: 120_000 }, () => {
  /** How long the run gets before the outer window fires; the stub below never finishes on its own.
   * agent-do-94t: was 3s, which under VM load killed the run before the stub had written its pid file. */
  const OUTER_WINDOW_MS = 10_000;

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
      stubBody({
        extra: [
          'echo "$$" >> "$PID_FILE"',
          'bash -c \'while :; do sleep 5; done\' "$MARKER" &',
          'echo "$!" >> "$PID_FILE"',
          'wait',
        ].join('\n'),
      }),
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
    for (let i = 0; i < 40 && stillAlive; i++) { // agent-do-94t: 20x250ms starved under load
      stillAlive = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).status === 0;
      if (stillAlive) await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
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
  }, 90_000); // agent-do-94t: 30s timed out under load (run C, 705a26f)
});

describe('tools/fast-gate.sh — a suite that leaves a process behind', { timeout: 120_000 }, () => {
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
      stubBody({
        // Not a single simple command: bash -c with one command would exec and drop the marker.
        extra: 'bash -c \'while :; do sleep 5; done\' "$MARKER" &',
      }),
      { mode: 0o755 },
    );

    const r = spawnSync('bash', [join(fx.repo, 'tools', 'fast-gate.sh'), '--changed', 'src/a.ts'], {
      cwd: fx.repo,
      encoding: 'utf8',
      timeout: 180_000, // agent-do-94t: 60s starved under load
      env: { ...process.env, FAST_GATE_RUNNER: stub, STATIC_CMD: 'true', RUN_LOG: fx.log, MARKER: marker },
    });

    // The gate must still deliver its verdict: the cleanup runs after the suites have reported.
    expect(`${r.stdout ?? ''}${r.stderr ?? ''}`).toContain('fast-gate: passed: tests/a.test.ts');
    expect(r.status).toBe(0);

    let stillAlive = true;
    for (let i = 0; i < 40 && stillAlive; i++) { // agent-do-94t: 20x250ms starved under load
      stillAlive = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).status === 0;
      if (stillAlive) await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
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
  }, 90_000); // agent-do-94t: 30s timed out under load
});

describe('tools/fast-gate.sh — reaping must not depend on helper processes', { timeout: 120_000 }, () => {
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
      stubBody({
        extra: 'bash -c \'while :; do sleep 5; done\' "$MARKER" &',
      }),
      { mode: 0o755 },
    );

    const r = spawnSync('bash', [join(fx.repo, 'tools', 'fast-gate.sh'), '--changed', 'src/a.ts'], {
      cwd: fx.repo,
      encoding: 'utf8',
      timeout: 180_000, // agent-do-94t: 60s starved under load
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
    for (let i = 0; i < 40 && stillAlive; i++) { // agent-do-94t: 20x250ms starved under load
      stillAlive = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).status === 0;
      if (stillAlive) await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
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
  }, 90_000); // agent-do-94t: 30s timed out under load
});

describe('tools/fast-gate.sh — teardown before the caller checks the slot', { timeout: 120_000 }, () => {
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
      stubBody({
        // Ignores TERM, so only the KILL pass ends it — the case where teardown takes the longest.
        extra: 'bash -c \'trap "" TERM; while :; do sleep 5; done\' "$MARKER" &',
      }),
      { mode: 0o755 },
    );

    const r = spawnSync('bash', [join(fx.repo, 'tools', 'fast-gate.sh'), '--changed', 'src/a.ts'], {
      cwd: fx.repo,
      encoding: 'utf8',
      timeout: 180_000, // agent-do-94t: 60s starved under load
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
  }, 90_000); // agent-do-94t: 30s timed out under load
});

describe('tools/fast-gate.sh — the bound kill still leaves a verdict', { timeout: 120_000 }, () => {
  it('prints a fast-gate: unknown marker when the outer bound kills it', async () => {
    // agent-do-wot (found by rev-45 reviewing agent-do-qmx): the TERM path reaped the tree but exited without
    // saying anything, so the coverage extractor saw no result at all — the exact failure this bead exists to
    // fix. The marker must be line-anchored, because remote/check-coverage.py matches ^fast-gate:\s*unknown:
    const fx = fixture();
    const hang = join(fx.root, 'hang');
    writeFileSync(hang, '#!/usr/bin/env bash\nwhile :; do sleep 1; done\n', { mode: 0o755 });

    // `timeout --foreground -k 30 3` mirrors the real path: fleet-check invokes the gate as
    // `timeout --foreground -k 30 <CHECK_FAST_TIMEOUT>` (the kill-window bound test reads that file), and
    // --foreground matters — without it coreutils signals the whole process group, which would mask a
    // leak this test is meant to catch. The KILL grace is the number that must match production
    // (agent-do-7ix): with -k 5 the trap had 5 s to print the marker, reap the tree and exit, and under
    // fleet load a correct reap occasionally exceeded it — the wrapper escalated to SIGKILL and the run
    // read 137 instead of 124, a false red on a working gate. The real grace is 30 s; mirroring it makes
    // the assertion deterministic without weakening anything it proves.
    // (agent-do-94t hit the same 137-vs-124 race independently on 2026-10-26 — run C, 705a26f — and widened
    // the window to `-k 15 10`; the 7ix mirroring of production's real 30 s grace supersedes that: same cure,
    // better fidelity. The 124 assertion stays the point of the test either way.)
    const r = spawnSync(
      'timeout',
      ['--foreground', '-k', '30', '3', 'bash', join(fx.repo, 'tools', 'fast-gate.sh'), '--changed', 'src/a.ts'],
      {
        cwd: fx.repo,
        encoding: 'utf8',
        timeout: 60_000,
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
  }, 90_000); // agent-do-94t: headroom above the 60s spawnSync cap under load (7ix sized 65s; 5s of bookkeeping margin was too thin on the loaded VM)
});

describe('tools/install-gate.sh — the unlanded-config guard (agent-do-llc, agent-do-fqv)', { timeout: 120_000 }, () => {
  // The installed check.conf is MACHINE-GLOBAL, so the installer must fail closed: a config that differs
  // from origin/main's — or one that CANNOT be compared to origin/main (no checkout, missing ref, file
  // absent from main; agent-do-fqv) — is refused unless the operator deliberately overrides. Sandboxed
  // git repos keep this independent of the branch the suite itself runs on.
  const script = readFileSync(join(REPO, 'tools', 'install-gate.sh'), 'utf8');
  const gitEnv = {
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  };

  function sandbox(conf: string): { root: string; repo: string } {
    const root = mkdtempSync(join(tmpdir(), 'agent-do-install-gate-'));
    ROOTS.push(root);
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'tools'), { recursive: true });
    writeFileSync(join(repo, 'tools', 'install-gate.sh'), script, { mode: 0o755 });
    writeFileSync(join(repo, 'tools', 'check.conf'), conf);
    return { root, repo };
  }

  const runInstall = (repo: string, dst: string, env: Record<string, string> = {}) =>
    spawnSync('bash', [join(repo, 'tools', 'install-gate.sh'), dst], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, ...gitEnv, ...env },
    });

  it('fails CLOSED when the source cannot be compared to origin/main, unless overridden', () => {
    const { root, repo } = sandbox("CHECK_CMD='true'\nCHECK_FAST_CMD='true'\nCHECK_FAST_TIMEOUT=1\n");
    spawnSync('git', ['-C', repo, 'init', '-q'], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, ...gitEnv } });
    const dst = join(root, 'live', 'check.conf');

    const refused = runInstall(repo, dst);
    expect(refused.status, 'an unverifiable source must be refused, not warned-and-installed (agent-do-fqv)').toBe(1);
    expect(refused.stdout + refused.stderr).toContain('fails CLOSED');
    expect(existsSync(dst), 'a refused install must not write the destination').toBe(false);

    const overridden = runInstall(repo, dst, { INSTALL_GATE_ALLOW_UNLANDED: '1' });
    expect(overridden.status).toBe(0);
    expect(existsSync(dst)).toBe(true);
    expect(readFileSync(dst + '.provenance', 'utf8'), 'the provenance must say the source was unverifiable').toContain('UNVERIFIABLE');
  }, 60_000);

  it('refuses a config that differs from origin/main, and installs it only with the loud override', () => {
    const { root, repo } = sandbox("CHECK_CMD='true'\nCHECK_FAST_CMD='true'\nCHECK_FAST_TIMEOUT=1\n");
    const git = (...args: string[]) =>
      spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, ...gitEnv } });
    git('init', '-q', '-b', 'main');
    git('add', 'tools');
    git('commit', '-qm', 'landed conf');
    spawnSync('git', ['init', '-q', '--bare', join(root, 'origin.git')], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, ...gitEnv } });
    git('remote', 'add', 'origin', join(root, 'origin.git'));
    git('push', '-q', 'origin', 'main');
    // The branch now carries an UNLANDED change to the config.
    writeFileSync(join(repo, 'tools', 'check.conf'), "CHECK_CMD='true'\nCHECK_FAST_CMD='true'\nCHECK_FAST_TIMEOUT=960\n");
    const dst = join(root, 'live', 'check.conf');

    const refused = runInstall(repo, dst);
    expect(refused.status, 'a config main does not describe must be refused (agent-do-llc)').toBe(1);
    expect(refused.stdout + refused.stderr).toContain('UNLANDED');
    expect(existsSync(dst)).toBe(false);

    const overridden = runInstall(repo, dst, { INSTALL_GATE_ALLOW_UNLANDED: '1' });
    expect(overridden.status).toBe(0);
    expect(readFileSync(dst, 'utf8')).toContain('CHECK_FAST_TIMEOUT=960');
    expect(readFileSync(dst + '.provenance', 'utf8')).toContain('matches_origin_main: NO');
  }, 90_000);
});

describe('tools/fast-gate.sh — a bound kill during the static step', { timeout: 120_000 }, () => {
  it('prints the unknown marker and reaps the static step', async () => {
    // rev-48, review round 3: the traps were installed AFTER STATIC_CMD, so a bound kill during the static step
    // emitted no marker at all (the same defect one stage earlier) and left the step's process holding the heavy
    // slot. The traps now sit above the static step, which runs in its own recorded session so the same trap
    // reaps it.
    const fx = fixture();
    const stub = join(fx.root, `static-hang-${process.pid}-${Date.now()}`);
    writeFileSync(stub, '#!/usr/bin/env bash\nwhile :; do sleep 1; done\n', { mode: 0o755 });

    // --foreground again: fleet-check's real bound does not signal the process group, so a static step left
    // running after the bound fires is exactly what this case must catch. -k mirrors production's 30 s grace
    // (agent-do-7ix): 5 s starved a correct trap-and-reap under load and escalated to SIGKILL, so the run
    // read 137 instead of 124 — a false red on a working gate. (agent-do-94t widened this window
    // independently the same day; the production-mirroring grace supersedes it.)
    const r = spawnSync(
      'timeout',
      ['--foreground', '-k', '30', '3', 'bash', join(fx.repo, 'tools', 'fast-gate.sh'), '--changed', 'tests/gates.test.ts'],
      {
        cwd: fx.repo,
        encoding: 'utf8',
        timeout: 60_000,
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
  }, 90_000); // agent-do-94t: headroom above the 60s spawnSync cap under load
});

describe('the gate re-checks its own generated metadata (agent-do-s5u)', { timeout: 120_000 }, () => {
  it('runs the suite-map sync check in the static step, before the build', () => {
    // A stale map is INVISIBLE to the fast tier: tests/gates.test.ts only runs when the map itself is among the
    // changed files, so a branch that adds an import edge selects a suite set which EXCLUDES the test that would
    // catch it - green locally, red only at the merger's full gate (25-45 min of the one heavy slot). The static
    // step is the same command in both tiers, so pinning it here is what stops a later tools/gate.conf edit from
    // silently dropping the check that agent-do-s5u added.
    const conf = readFileSync(join(REPO, 'tools', 'gate.conf'), 'utf8');
    const staticCmd = /^STATIC_CMD="([^"]*)"/m.exec(conf)?.[1];
    expect(staticCmd, 'tools/gate.conf must define STATIC_CMD as one double-quoted line').toBeTruthy();
    expect(staticCmd!).toContain('tools/gen-suite-map.mjs --check');
    // Order matters: the check is sub-second and needs no suites, so it must fail before the ~14s build.
    expect(staticCmd!.indexOf('gen-suite-map')).toBeLessThan(staticCmd!.indexOf('npm run build'));
    // And it must be a real check, not an echo: --check exits non-zero on drift (measured, agent-do-s5u).
    expect(staticCmd!).not.toContain('--check ||');
  });
});

describe('the suite map sees suites that read source as DATA (agent-do-9im)', { timeout: 120_000 }, () => {
  // The import graph cannot see a `readFileSync`, so an invariant suite that asserts on the TEXT of source files
  // used to be invisible to affected-only selection: the fast gate passed while `cli-answer-stream.test.ts` failed on
  // `src/cli/eval-cmd.ts`, and the reviewer caught it rather than the gate. Suites now declare what they read with
  // `// @reads <glob>`; these assertions pin that the declaration actually reaches the map, and that it keeps
  // working for files that do not exist yet.
  const mapRows = (): Map<string, string[]> => {
    const rows = new Map<string, string[]>();
    for (const line of readFileSync(join(REPO, 'tools/suite-map.tsv'), 'utf8').split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const [glob, ...suites] = line.split('\t');
      if (!suites.length) continue;
      rows.set(glob, suites.join(' ').split(/\s+/).filter(Boolean));
    }
    return rows;
  };

  it('maps every src/cli module to the stdout invariant suite', () => {
    const rows = mapRows();
    const cliModules = readdirSync(join(REPO, 'src/cli'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => `src/cli/${f}`);
    expect(cliModules.length).toBeGreaterThan(5);
    const uncovered = cliModules.filter((m) => !(rows.get(m) ?? []).includes('tests/cli-answer-stream.test.ts'));
    expect(uncovered, 'these src/cli modules would change without the stdout invariant being selected').toEqual([]);
  });

  it('still maps the module that exposed the gap', () => {
    // agent-do-9im's counterexample: this one was reached by no suite at all, so a change to it selected only the
    // suites whose own files changed.
    expect(mapRows().get('src/cli/eval-cmd.ts')).toContain('tests/cli-answer-stream.test.ts');
  });
});
