/**
 * Gate CONFIG-BOUND tests: the pins that read tools/check.conf, tools/gate.conf and tools/fast-gate.sh
 * as data — readBound() (the bash-sourcing-semantics bound reader), countTraceAssignments(), the two
 * kill-window pins that use them, and the readBound behaviour suite.
 *
 * WHY a separate file (agent-do-1o5o, ADR agent-do-hf2f): tests/gates.test.ts is the fleet's
 * everyone-edits file — 20 landings in 30 days — and a test-only amendment to a config-bound pin paid
 * for the whole gate-behaviour suite (~53 s cached fast wall) without being able to affect gate
 * selection. The config pins live here; gate SELECTION, teardown and fixture behaviour stay in
 * tests/gates.test.ts. tools/gen-suite-map.mjs maps every tools/* change to BOTH suites, so a gate
 * script or config change still cannot land without both green.
 *
 * Everything here is hermetic: readBound sources a throwaway conf in bash, nothing reads or writes a
 * shared path, and no fixture state is shared with tests/gates.test.ts.
 *
 * @reads tools/*.conf
 * @reads tools/*.sh
 */
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
