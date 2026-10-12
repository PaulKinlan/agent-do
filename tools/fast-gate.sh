#!/usr/bin/env bash
# tools/fast-gate.sh — the FAST tier: the static check plus the suites that cover what a change can affect,
# failing LOUDLY on a changed file that maps to none.
#
# Why it exists — all of it is ~/fleet/docs/speed.md, and all of it is measured on this fleet:
#   * R2: the fast gate is the implementer's gate and must be a STRICT SUBSET of the full gate. Here that is
#     exactly true: fast = STATIC_CMD + the affected suites; full = STATIC_CMD + every suite (+ the eval
#     tier). Nothing runs in the fast tier that the full tier does not run.
#   * R5: selection is affected-only and "the map fails loudly on an unmapped file"; independent suites run
#     in PARALLEL PROCESSES, because a test file is the unit of parallelism. A run that imports every test
#     into one process pays every test of wall time.
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
#   fast-gate: passed: <suite>            (positive marker: this suite really executed)
#   fast-gate: failed: <suite>
#   fast-gate: unmapped: <path>           (the fail-loud case, and the process exits 1)
#   fast-gate: unknown: <reason>          (a step before the suites failed: nothing below it was exercised)
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
SUITE_BOUND=${SUITE_BOUND:-180}

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
  for f in $(printf '%s\n' "${UNMAPPED[@]}" | sort -u); do echo "fast-gate: unmapped: $f"; done
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

# --- the STATIC step: the same command the full gate runs (R2/R8), once ---------------------------------
# It exists in the fast tier because this is a TypeScript repo and the suite runner TRANSPILES without
# type-checking: without this step a changed file with a type error is green on the fast gate and red on
# the merger's build, i.e. the fast gate would be certifying something it never looked at.
printf '\n[gate] static: %s\n' "$STATIC_CMD"
if ! ( cd "$ROOT" && eval "$STATIC_CMD" ); then
  echo 'fast-gate: unknown: STATIC_CMD failed, so no suite was reached (this is NOT a test result)'
  exit 1
fi

# --- run the suites, one process per suite, bounded parallelism ----------------------------------------
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
MISSING=()
for s in "${SELECTED[@]}"; do [ -f "$ROOT/$s" ] || MISSING+=("$s"); done
if [ "${#MISSING[@]}" -gt 0 ]; then
  printf 'fast-gate: missing: %s\n' "${MISSING[@]}"
  echo "fast-gate: FAIL - ${#MISSING[@]} suite(s) named in tools/suite-map.tsv do not exist; the map is" >&2
  echo "fast-gate: stale (a renamed or deleted suite reads as green forever otherwise). Fix the map." >&2
  exit 1
fi

printf 'fast-gate: running: %s\n' "${SELECTED[@]}"
n=0
for s in "${SELECTED[@]}"; do
  key=$(printf '%s' "$s" | tr '/.' '__')
  ( cd "$ROOT" && timeout -k 15 "$SUITE_BOUND" $FAST_GATE_RUNNER "$s" >"$TMP/$key.log" 2>&1; echo $? >"$TMP/$key.rc" ) &
  n=$((n + 1))
  if [ "$n" -ge "$JOBS" ]; then wait -n; n=$((n - 1)); fi
done
wait

rc=0
for s in "${SELECTED[@]}"; do
  key=$(printf '%s' "$s" | tr '/.' '__')
  if [ "$(cat "$TMP/$key.rc" 2>/dev/null)" = 0 ]; then
    echo "fast-gate: passed: $s"
  else
    echo "fast-gate: failed: $s"
    sed 's/^/    /' "$TMP/$key.log" 2>/dev/null | tail -40
    rc=1
  fi
done
[ "$rc" -eq 0 ] && echo "fast-gate: PASS (${#SELECTED[@]} suite(s), ${#CHANGED[@]} changed file(s))" \
                || echo "fast-gate: FAIL (see the suite logs above)" >&2
exit $rc
