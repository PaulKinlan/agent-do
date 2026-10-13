#!/usr/bin/env bash
# tools/fast-gate.sh — the FAST tier: the static check plus the suites that cover what a change can affect,
# failing LOUDLY on a changed file that maps to none.
#
# Why it exists — all of it is ~/fleet/docs/speed.md, and all of it is measured on this fleet:
#   * R2: the fast gate is the implementer's gate and must be a STRICT SUBSET of the full gate. Here that is
#     exactly true: fast = STATIC_CMD + the affected suites; full = STATIC_CMD + every suite (+ the eval
#     tier). Nothing runs in the fast tier that the full tier does not run.
#   * R5: selection is affected-only and "the map fails loudly on an unmapped file"; the affected suites run in
#     ONE runner invocation, because a test file is still the unit of parallelism (vitest parallelises files
#     inside the process) while process START-UP is per invocation. Starting one process per suite paid that
#     start-up 37 times for a hub-module change (agent-do-00f, measured: 54 s to run 37 of 50 suites, slower
#     than the full gate, which starts one process for all of them).
#   * R8: no step runs twice, and the static check is the same command in both tiers.
#   * R14: a repo whose fast gate has unmapped changed files is guessing.
#   * fleet-1n0z / roles/lessons.md: an affected-only gate is a false-green generator with two failure modes.
#     (a) a changed module that maps to ZERO suites IS detectable from the mapping, and this script detects
#     it and exits non-zero. (b) a changed module that maps to SOME but not all of its covering suites is
#     NOT detectable by enumerating what ran — only an independent oracle (the full gate on the merged
#     union) can see that. Do not read this script's green as proof of (b); it is proof of (a) only.
#
# Output contract — these exact lines are parsed by ~/fleet/remote/check-coverage.py, which is what puts
# `suites`/`unmapped`/`omitted` into the cached ~/.fleet/checks/<tree>.fast.json record a reviewer reads:
#   fast-gate: running: <suite>
#   fast-gate: passed: <suite>            (positive marker: this suite really executed - the runner's report
#                                          named this file and its status was passed)
#   fast-gate: failed: <suite>            (the suite failed, was ABSENT from the runner's report, or the batch
#                                          produced no report at all. A suite the report does not mention was
#                                          not demonstrated to run, so it is not reported passed.)
#   fast-gate: unmapped: <path>           (the fail-loud case, and the process exits 1)
#   fast-gate: unknown: <reason>          (a step before the suites failed, or the outer bound killed this
#                                          script before a verdict: nothing was measured either way)
# Do not reformat those lines. They are anchored at line start with the `fast-gate:` prefix by design
# (docs/speed.md R15): an unanchored token is harvested out of ordinary test output as if it were a marker.
#
# Usage:
#   bash tools/fast-gate.sh                     # changed paths vs the merge-base with origin/main (or main)
#   bash tools/fast-gate.sh --changed src/a.ts  # repeatable; bypasses git entirely
#   bash tools/fast-gate.sh --list              # print the suites it WOULD run, run nothing
#   bash tools/fast-gate.sh --base <ref>        # compare against another base
#   FAST_GATE_JOBS=2 bash tools/fast-gate.sh    # cap parallel suites (default: 4)
#
# Exit codes: 0 = every selected suite passed (or nothing was affected); 1 = a suite failed, a step failed,
# a mapped suite is missing, or a changed file is unmapped. ANY non-zero is "unknown", never "green".
set -uo pipefail

# --- verdict bookkeeping, installed before any work: the outer window can TERM this script at any stage,
# including during argument parsing and the base lookup below, and a run that dies without a
# marker is recorded as *no result at all* (agent-do-wot). rev-48 caught the first attempt
# installing these after STATIC_CMD, which left the static step able to die silently.
# SIGTERM/SIGINT must run the cleanup too: without these traps bash dies straight away on the bound kill and
# the EXIT trap never fires, which is how the orphans happened.
#
# AND IT MUST LEAVE A VERDICT (agent-do-wot, found by rev-45). The outer window (CHECK_FAST_TIMEOUT) TERMs this
# script; the coverage extractor needs `fast-gate: unknown: <reason>` starting at the beginning of a line, or
# the run reads as "no result at all" - which is the very class of bug this bead exists to fix. Printed before
# the cleanup so it survives however long reaping takes, and only while no verdict has been emitted yet, so a
# late TERM cannot contradict a PASS/FAIL that already went out.
VERDICT_EMITTED=0
emit_bound_unknown() {
  [ "$VERDICT_EMITTED" = 1 ] && return 0
  VERDICT_EMITTED=1
  # The leading newline is deliberate: the last suite may have been killed mid-line, and a marker appended to
  # that partial line would not match the extractor's line-anchored pattern (remote/check-coverage.py).
  printf '\nfast-gate: unknown: killed by the outer bound (%s) before a verdict - no suite result\n' "$1"
}
bound_kill() {
  emit_bound_unknown "$1"
  # cleanup() exists only once the scratch dir does. Before that there is nothing to reap, and a missing cleanup
  # must not turn the marker itself into an error - the marker is the part that has to survive.
  if declare -F cleanup >/dev/null 2>&1; then cleanup; fi
  exit 130
}
trap 'bound_kill SIGTERM' TERM
trap 'bound_kill SIGINT' INT

HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
MAP="$HERE/suite-map.tsv"
CONF="$HERE/gate.conf"

[ -f "$MAP" ] || { echo "fast-gate: no $MAP — the map IS the gate; refusing to guess" >&2; exit 1; }
# An explicitly exported value wins over the repo's: capture it before sourcing gate.conf. (A plain
# assignment in gate.conf plus this capture, rather than a shell `${VAR:-default}` form there, because a
# value containing a placeholder inside a default form is parsed wrong — see tools/gate.conf.)
_ENV_RUNNER=${FAST_GATE_RUNNER-}
_ENV_STATIC=${STATIC_CMD-}
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"
[ -n "$_ENV_RUNNER" ] && FAST_GATE_RUNNER=$_ENV_RUNNER
[ -n "$_ENV_STATIC" ] && STATIC_CMD=$_ENV_STATIC
FAST_GATE_RUNNER=${FAST_GATE_RUNNER:-npx vitest run}
STATIC_CMD=${STATIC_CMD:-true}
JOBS=${FAST_GATE_JOBS:-4}
# Kill window for the whole batch. MUST stay below the outer window (CHECK_FAST_TIMEOUT in tools/check.conf,
# 180 s): the batch bound exists so that a wedged run is reported as `fast-gate: failed: <suite>` - for every
# selected suite, since a batch that never produced a report proves nothing about any of them - together with
# its log tail. If the outer window fires first it is reported as `unknown` in the cached record instead —
# the same value in both places made that a race, not a decision. 120 s + the 15 s SIGKILL grace the runner
# is given below + the static step (~14 s on a 2-vCPU VM) fits inside 180 s with room to spare.
# tests/gates.test.ts pins the relationship against tools/check.conf rather than trusting this comment.
SUITE_BOUND=${SUITE_BOUND:-120}

LIST=0; BASE="${FAST_GATE_BASE:-}"; EXPLICIT=()
while [ $# -gt 0 ]; do
  case $1 in
    --list)    LIST=1; shift ;;
    --changed) EXPLICIT+=("${2:?--changed needs a path}"); shift 2 ;;
    --base)    BASE="${2:?--base needs a ref}"; shift 2 ;;
    *)         echo "fast-gate: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

# --- the base: origin/main, then main, then HEAD~1. Never silently "everything". ------------------------
if [ "${#EXPLICIT[@]}" -eq 0 ]; then
  if [ -z "$BASE" ]; then
    for b in origin/main main origin/master master; do
      git -C "$ROOT" rev-parse --verify --quiet "$b" >/dev/null 2>&1 && { BASE=$b; break; }
    done
  fi
  [ -n "$BASE" ] || { echo "fast-gate: no base ref (no origin/main, no main) and no --changed given" >&2; exit 1; }
  MB=$(git -C "$ROOT" merge-base "$BASE" HEAD) || { echo "fast-gate: cannot merge-base $BASE..HEAD" >&2; exit 1; }
  # Committed, uncommitted and untracked all count. A selector that MISSES a file you just wrote is the
  # defect this script exists to prevent, so over-inclusion is deliberate.
  mapfile -t CHANGED < <( { git -C "$ROOT" diff --name-only "$MB"..HEAD
                            git -C "$ROOT" diff --name-only
                            git -C "$ROOT" ls-files --others --exclude-standard; } 2>/dev/null \
                          | sed '/^$/d' | sort -u )
else
  CHANGED=("${EXPLICIT[@]}")
fi

is_exempt() { # $1 = path ; true iff a `!` row matches it
  local pat
  while IFS=$'\t' read -r pat _; do
    # NOTE: the pattern side of `[[ ]]` must stay UNQUOTED or it is compared as a literal string. (Measured
    # on the fleet template: `[[ "$f" == "${pat#!}" ]]` matched nothing, so every exemption was silently
    # inert and every doc-only change was reported as an unmapped changed file.)
    case $pat in \!*) [ -n "${pat#!}" ] || continue; [[ $1 == ${pat#!} ]] && return 0 ;; esac
  done < "$MAP"
  return 1
}

suites_for() { # $1 = path -> newline-separated suites (empty = unmapped)
  local pat rest
  # A changed suite maps to itself. R14 names this exact case.
  case $1 in tests/*.test.ts|tests/*.test.tsx|tests/*.test.js) echo "$1"; return ;; esac
  # ACCUMULATE every matching row, do not stop at the first (fleet-w7so). A `return` after the first hit
  # means a row APPENDED for a module that already had one is silently ignored — a lane adds coverage to
  # tools/suite-map.tsv, sees the gate stay green, and believes its new suite ran. Rows are additive; the
  # caller de-duplicates, so naming a suite twice is harmless.
  while IFS=$'\t' read -r pat rest; do
    case $pat in ''|\#*|\!*) continue ;; esac
    if [[ $1 == $pat ]]; then
      printf '%s\n' $rest          # word-split on purpose: one row names several suites
    fi
  done < "$MAP"
  return
}

UNMAPPED=(); EXEMPT_COUNT=0; SELECTED=()
for f in ${CHANGED[@]+"${CHANGED[@]}"}; do
  got=$(suites_for "$f")
  if [ -n "$got" ]; then
    while IFS= read -r s; do [ -n "$s" ] && SELECTED+=("$s"); done <<<"$got"
  elif is_exempt "$f"; then
    EXEMPT_COUNT=$((EXEMPT_COUNT + 1))
  else
    UNMAPPED+=("$f")
  fi
done

# --- fail loudly on anything unmapped, BEFORE running a subset that would look green -------------------
if [ "${#UNMAPPED[@]}" -gt 0 ]; then
  # mapfile, NOT `for f in $(...)`: an unquoted substitution word-SPLITS a changed path containing a space
  # and pathname-EXPANDS one containing * ? or [, so a single changed file could be reported as several
  # unmapped paths, or as paths that never changed (e.g. `--changed 'src/*.ts'` against a real checkout).
  # ~/fleet/remote/check-coverage.py harvests these lines into the cached fast record.
  mapfile -t UNMAPPED_UNIQ < <(printf '%s\n' "${UNMAPPED[@]}" | sort -u)
  for f in "${UNMAPPED_UNIQ[@]}"; do echo "fast-gate: unmapped: $f"; done
  echo "fast-gate: FAIL - ${#UNMAPPED[@]} changed file(s) map to no suite in tools/suite-map.tsv." >&2
  echo "fast-gate: a changed module that maps to zero suites is exactly the false-green case fleet-1n0z" >&2
  echo "fast-gate: describes. Either the module has a suite that the map does not name (run" >&2
  echo "fast-gate: \`node tools/gen-suite-map.mjs\` — the map is generated from the import graph), or it has" >&2
  echo "fast-gate: none and the fix is a test. An exemption is a claim that no suite can EVER cover it, and" >&2
  echo "fast-gate: for package.json / package-lock.json / vitest.config.ts it is deliberately absent: those" >&2
  echo "fast-gate: reach every suite, so they are gated by the full tier (see docs/speed.md)." >&2
  exit 1
fi

mapfile -t SELECTED < <(printf '%s\n' ${SELECTED[@]+"${SELECTED[@]}"} | sed '/^$/d' | sort -u)

if [ "${#SELECTED[@]}" -eq 0 ]; then
  echo "fast-gate: no suites affected by ${#CHANGED[@]} changed file(s) (${EXEMPT_COUNT} exempt)"
  exit 0
fi

if [ "$LIST" -eq 1 ]; then
  printf '%s\n' "${SELECTED[@]}"
  exit 0
fi

TMP=$(mktemp -d)
CHILD_PIDS=()
CLEANED=0
HAVE_SETSID=0
HAVE_PROC=0
command -v setsid >/dev/null 2>&1 && HAVE_SETSID=1
[ -r /proc/self/stat ] && HAVE_PROC=1

# The reaper reads /proc and signals with the `kill` BUILTIN. That is deliberate, and it is the second fix in
# this bead: the first version shelled out to `pgrep -P` and `pkill -s`, every failure swallowed by
# `2>/dev/null || true`. Under contention those forks can fail, and the reaper then silently degraded to killing
# nothing exactly when the VM was busy — measured: two cases in tests/gates.test.ts failed in a gate run that
# shared the VM with the merger's full gate, while the same suite passed on an idle VM, and the gate still left
# descendants behind. A reaper whose failure mode is "quietly do nothing" is worse than none, so this one spawns
# no process at all: it reads /proc with the shell's own builtins.
SELF_SID=0
if [ "$HAVE_PROC" = 1 ]; then
  IFS= read -r _fg_stat < /proc/self/stat 2>/dev/null || _fg_stat=""
  _fg_rest=${_fg_stat##*) }
  IFS=' ' read -r _fg_state _fg_ppid _fg_pgrp _fg_sid _fg_junk <<<"$_fg_rest"
  SELF_SID=${_fg_sid:-0}
fi
[ -n "$SELF_SID" ] || SELF_SID=0

# Process table snapshot, one "<pid> <ppid> <pgrp> <session>" line per process. The comm field may contain
# spaces and parentheses, so only what follows the LAST ')' is split.
PROC_TABLE=""
build_proc_table() {
  local stat line pid rest out=""
  for stat in /proc/[0-9]*/stat; do
    [ -r "$stat" ] || continue
    # 2>/dev/null BEFORE the input redirection: redirections are applied left to right, so a process that
    # dies between the `-r` check above and this read would otherwise print its own warning to our stderr.
    IFS= read -r line 2>/dev/null <"$stat" || continue
    pid=${line%% *}
    rest=${line##*) }
    set -- $rest
    out="$out$pid $2 $3 $4"$'\n'
  done
  PROC_TABLE=$out
}

# Signal every process in session $3 (skipping $4 and the caller) plus the group each belongs to. The session is
# the sweep that matters: it covers a suite that has ALREADY reported and left a descendant behind (measured: a
# passing run left vitest processes holding the heavy slot), which no pid or parent walk can find, because the
# recorded child has been reaped and its orphans reparented. The group signal is what reaches a runner's own
# children, which `timeout` has moved into a new group.
kill_session() { # $1 = signal, $2 = caller pid, $3 = session id, $4 = pid to spare
  # Capture the parameters BEFORE the table is parsed: `set --` below rebinds $1.. and would otherwise make the
  # signal name and the session id read as fields of the row under inspection (that bug cost a local gate run).
  local sig=$1 caller=$2 want_sid=$3 spare=$4
  local line pid ppid pgrp sid
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    set -- $line
    pid=$1 pgrp=$3 sid=$4
    [ "$sid" = "$want_sid" ] || continue
    [ -n "$caller" ] && [ "$pid" = "$caller" ] && continue
    [ -n "$spare" ] && [ "$pid" = "$spare" ] && continue
    [ "$pgrp" = "$sid" ] && kill "-$sig" "-$pgrp" 2>/dev/null
    kill "-$sig" "$pid" 2>/dev/null
  done <<<"$PROC_TABLE"
}

# Fallback for a suite that never got its own session (no setsid here): walk the recorded child's tree, children
# first, from the same snapshot. Without /proc only the child itself can be signalled, which is said out loud by
# the caller rather than left to be assumed.
kill_tree() { # $1 = signal, $2 = pid
  local sig=$1 root=$2 kids="" line pid ppid ppid_row
  if [ "$HAVE_PROC" != 1 ]; then
    kill "-$sig" "$root" 2>/dev/null || true
    return 0
  fi
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    set -- $line
    pid=$1 ppid_row=$2
    [ "$ppid_row" = "$root" ] && kids="$kids $pid"
  done <<<"$PROC_TABLE"
  for pid in $kids; do
    kill_tree "$sig" "$pid"
  done
  kill "-$sig" "$root" 2>/dev/null || true
}

# Signal everything the suites left behind, in one /proc snapshot per pass.
reap() { # $1 = signal name
  local pid sid
  [ "$HAVE_PROC" = 1 ] && build_proc_table
  for pid in "${CHILD_PIDS[@]:-}"; do
    [ -n "$pid" ] || continue
    kill_tree "$1" "$pid"
  done
  [ "$HAVE_PROC" = 1 ] || return 0
  local f
  for f in "$TMP"/*.sid; do
    [ -f "$f" ] || continue
    IFS= read -r sid 2>/dev/null <"$f" || continue
    case "$sid" in
      '' | *[!0-9]*) continue ;;
    esac
    # Never signal our own session: that would take the caller down with the gate.
    [ "$sid" -gt 1 ] 2>/dev/null || continue
    [ "$SELF_SID" != "$sid" ] || continue
    kill_session "$1" "" "$sid" ""
  done
}

# Are any processes still alive in the sessions we started? Used by the teardown wait below.
session_members_exist() {
  local line pid sid f
  [ "$HAVE_PROC" = 1 ] || return 1
  build_proc_table
  for f in "$TMP"/*.sid; do
    [ -f "$f" ] || continue
    IFS= read -r sid 2>/dev/null <"$f" || continue
    case "$sid" in
      '' | *[!0-9]*) continue ;;
    esac
    [ "$sid" -gt 1 ] 2>/dev/null || continue
    [ "$SELF_SID" != "$sid" ] || continue
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      set -- $line
      pid=$1
      [ "$4" = "$sid" ] && [ "$pid" != "$$" ] && return 0
    done <<<"$PROC_TABLE"
  done
  return 1
}

# Reap the suite processes BEFORE removing the scratch directory (agent-do-qmx). The old EXIT-only trap did
# neither part: when the outer window (CHECK_FAST_TIMEOUT in tools/check.conf) killed this script, the
# in-flight runners and their descendants kept holding the heavy slot until fleet-heavy killed ~15 leftover
# processes, and `rm -rf "$TMP"` landed while the subshells were still writing their `.rc` files, so the run
# ended with one `No such file or directory` shell error per suite instead of a verdict.
cleanup() {
  [ "$CLEANED" = 1 ] && return 0
  CLEANED=1
  trap - EXIT INT TERM
  # Unconditional, and not gated on a recorded child still being alive: a successful suite can leave a worker
  # behind after its own subshell has been reaped, and that case has to be swept too.
  reap TERM
  sleep 0.3
  reap KILL
  wait 2>/dev/null || true
  # Let the kernel finish tearing the killed processes down before this script returns. fleet-heavy checks the
  # slot holders the instant the job ends, and a descendant that is still mid-exit shows up there as a leak:
  # measured, one pid on a run whose own scan found nothing even 1 s later (agent-do-qmx, P2 finding from the
  # pre-landing review). Bounded: at most ~1 s, and if `sleep` cannot spawn the loop simply stops waiting
  # rather than hanging, which is the old behaviour and not a new failure mode.
  if [ "$HAVE_PROC" = 1 ]; then
    local waited=0
    while [ "$waited" -lt 10 ] && session_members_exist; do
      sleep 0.1
      waited=$((waited + 1))
    done
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

# --- the STATIC step: the same command the full gate runs (R2/R8), once ---------------------------------
# It exists in the fast tier because this is a TypeScript repo and the suite runner TRANSPILES without
# type-checking: without this step a changed file with a type error is green on the fast gate and red on
# the merger's build, i.e. the fast gate would be certifying something it never looked at.
printf '\n[gate] static: %s\n' "$STATIC_CMD"
# Run it in its own session with that session recorded, exactly as the suites below are run. The traps above are
# installed before this point (rev-48, review round 3: they used to be installed after STATIC_CMD, so a bound kill
# during this step emitted no marker at all), and recording the session is what lets that same trap reap a killed
# `npm run build`/tsc instead of leaving it holding the heavy slot. Baseline command substitution is not used:
# every `$( )` would be a new child of a shell mid-teardown.
STATIC_RC=0
if [ "$HAVE_SETSID" = 1 ]; then
  setsid bash -c '
    cd "$1" || exit 1
    echo $$ >"$3"
    eval "$2"
  ' fast-gate-static "$ROOT" "$STATIC_CMD" "$TMP/static.sid" &
  static_pid=$!
  CHILD_PIDS+=("$static_pid")
  wait "$static_pid" || STATIC_RC=$?
else
  ( cd "$ROOT" && eval "$STATIC_CMD" ) || STATIC_RC=$?
fi
if [ "$STATIC_RC" -ne 0 ]; then
  echo 'fast-gate: unknown: STATIC_CMD failed, so no suite was reached (this is NOT a test result)'
  exit 1
fi

# --- run the suites: ONE invocation, its per-file report mapped back onto the suites we asked for ---------

MISSING=()
for s in "${SELECTED[@]}"; do [ -f "$ROOT/$s" ] || MISSING+=("$s"); done
if [ "${#MISSING[@]}" -gt 0 ]; then
  printf 'fast-gate: missing: %s\n' "${MISSING[@]}"
  echo "fast-gate: FAIL - ${#MISSING[@]} suite(s) named in tools/suite-map.tsv do not exist; the map is" >&2
  echo "fast-gate: stale (a renamed or deleted suite reads as green forever otherwise). Fix the map." >&2
  exit 1
fi

printf 'fast-gate: running: %s\n' "${SELECTED[@]}"

# The report the runner writes, the log it writes alongside it, and the file its exit code lands in. The log
# matters as much as the report: it is the tail printed on failure, and --reporter=default is what keeps it
# human-readable rather than a wall of JSON.
REPORT="$TMP/results.json"
RUN_LOG_FILE="$TMP/batch.log"
BATCH_RC_FILE="$TMP/batch.rc"

if [ "$HAVE_SETSID" = 1 ]; then
  # Own session for the batch (see reap): `setsid` execs in place, so `$!` and the pid the inner shell records
  # are the session id. RUNNER goes through the environment because it may carry arguments (`npx vitest run`),
  # which must keep splitting. Suites are passed last so the fixed paths above can be named positionally.
  RUNNER=$FAST_GATE_RUNNER setsid bash -c '
    cd "$1" || exit 1
    echo $$ >"$2"
    # shellcheck disable=SC2086
    timeout -k 15 "$3" $RUNNER "${@:6}" --reporter=json --outputFile="$5" --reporter=default >"$4.log" 2>&1
    echo $? >"$4"
  ' fast-gate-batch "$ROOT" "$TMP/batch.sid" "$SUITE_BOUND" "$TMP/batch" "$REPORT" "${SELECTED[@]}" &
else
  # No setsid: the tree walk in reap() is all that protects this run, so say so rather than pretend.
  echo "fast-gate: note: no setsid on this platform; the runner is killed by tree, which can miss a" >&2
  echo "fast-gate: note: reparented orphan after the batch has reported." >&2
  ( cd "$ROOT" && timeout -k 15 "$SUITE_BOUND" $FAST_GATE_RUNNER "${SELECTED[@]}" \
      --reporter=json --outputFile="$REPORT" --reporter=default >"$RUN_LOG_FILE" 2>&1; echo $? >"$BATCH_RC_FILE" ) &
fi
CHILD_PIDS+=("$!")
wait

BATCH_RC=$(cat "$BATCH_RC_FILE" 2>/dev/null)
[ -n "$BATCH_RC" ] || BATCH_RC=124   # no exit code recorded at all: killed, or never started. Never a pass.

# Map the per-file report back onto the suites we asked for, printing "<status> <suite>" per suite. node is used
# rather than jq because this is a node repo and jq is not guaranteed to exist; if this produces nothing - no
# node, no report, a report that will not parse, a batch killed before it wrote one - then NOTHING is mapped and
# every selected suite is reported failed below. That direction is the whole point (fleet-1n0z): a suite that did
# not demonstrably run must never be reported as passed, whatever went wrong.
GATE_ROOT="$ROOT" node -e '
  const fs = require("fs");
  const [report, ...suites] = process.argv.slice(1);
  const root = process.env.GATE_ROOT || "";
  const byName = new Map();
  try {
    const r = JSON.parse(fs.readFileSync(report, "utf8"));
    for (const t of r.testResults ?? []) byName.set(String(t.name ?? "").replace(/\\/g, "/"), t.status);
  } catch {
    // Deliberately empty: an unreadable report maps nothing, so nothing below can pass.
  }
  for (const s of suites) {
    // vitest reports absolute paths; match exactly first, then by suffix, because the runner root may be a
    // resolved symlink of ours and a path that merely ENDS in the suite name is still that suite in this repo.
    const status =
      byName.get(root + "/" + s) ?? byName.get(s) ??
      [...byName.entries()].find(([n]) => n.endsWith("/" + s))?.[1] ?? "";
    console.log((status === "passed" ? "passed" : "failed") + " " + s);
  }
' "$REPORT" "${SELECTED[@]}" >"$TMP/mapped" 2>/dev/null

rc=0
if [ -s "$TMP/mapped" ]; then
  while IFS= read -r line; do
    status=${line%% *}; suite=${line#* }
    [ -n "$suite" ] || continue
    if [ "$status" = passed ]; then
      echo "fast-gate: passed: $suite"
    else
      echo "fast-gate: failed: $suite"
      rc=1
    fi
  done <"$TMP/mapped"
else
  # No mapping was produced at all: every selected suite is unproven, so every one is reported failed.
  printf 'fast-gate: failed: %s\n' "${SELECTED[@]}"
  rc=1
fi

if [ "$rc" -ne 0 ]; then
  echo "fast-gate: runner exit $BATCH_RC (0 = a suite reported failed; 124/137/143 = the ${SUITE_BOUND}s batch bound killed it)" >&2
  sed 's/^/    /' "$RUN_LOG_FILE" 2>/dev/null | tail -40
  echo "fast-gate: FAIL (see the run log above)" >&2
else
  echo "fast-gate: PASS (${#SELECTED[@]} suite(s), ${#CHANGED[@]} changed file(s))"
fi
# A verdict is out: a TERM arriving now must not add a second, contradictory one (agent-do-wot).
VERDICT_EMITTED=1
exit $rc
