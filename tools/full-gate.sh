#!/usr/bin/env bash
# tools/full-gate.sh — the FULL gate: the static check, then every suite and the mock-tier evals.
#
# Who runs it, and when (~/fleet/docs/speed.md):
#   * the MERGER, once per landing, on the merged union of every cleared branch (R1, R11, R13);
#   * never an implementer lane while iterating — that is tools/fast-gate.sh / `fleet-check --fast` (R2).
#     `bin/fleet-check` enforces this: a non-merger lane asking for the full gate is refused unless it
#     passes --full.
# Budget: <= 300 s median on 8 vCPU (R1). Measured on this project 2026-10-12 on a 2-vCPU VM (nproc 2,
# i.e. half the standard's assumed shape, so these are upper bounds): 41.5 s (build 13.8 s, vitest 21.0 s,
# evals 1.4 s). Record the new number here when a change moves it materially (R4).
#
# It is also the independent oracle the fast gate cannot be: the fast gate proves that every changed file
# HAD a suite (fleet-1n0z mode (a)). It cannot prove that the suites it selected were ALL of them (mode
# (b)). This run is what can. `npm run eval` is here for the same reason: evals/** has no per-file suite,
# so the fast tier cannot select it and exempts it, and that exemption is only honest because this command
# exercises it.
set -uo pipefail

HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
CONF="$HERE/gate.conf"
# An explicitly exported value wins over the repo's: capture before sourcing tools/gate.conf (see the
# comment there for why an assignment plus a capture, rather than a default form).
_ENV_RUNNER=${FAST_GATE_RUNNER-}; _ENV_FULL=${FULL_TIER_CMD-}; _ENV_STATIC=${STATIC_CMD-}
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"
[ -n "$_ENV_RUNNER" ] && FAST_GATE_RUNNER=$_ENV_RUNNER
[ -n "$_ENV_FULL" ] && FULL_TIER_CMD=$_ENV_FULL
[ -n "$_ENV_STATIC" ] && STATIC_CMD=$_ENV_STATIC
STATIC_CMD=${STATIC_CMD:-true}
: "${FULL_TIER_CMD:?tools/gate.conf did not set FULL_TIER_CMD and no override was given}"

rc=0
step() { printf '\n[gate] %s\n' "$1"; }

step "static: $STATIC_CMD"
( cd "$ROOT" && eval "$STATIC_CMD" ) || rc=1

step "tests: $FULL_TIER_CMD"
( cd "$ROOT" && eval "$FULL_TIER_CMD" ) || rc=1

if [ "$rc" -eq 0 ]; then echo "full gate: PASS"; else echo "full gate: FAIL" >&2; fi
exit $rc
