#!/usr/bin/env bash
# tools/install-gate.sh — install this repo's gate commands as the active gate on THIS VM.
#
# `~/.fleet/check.conf` is MACHINE-GLOBAL: `bin/fleet-check` sources it for whatever repo it is invoked in,
# so the file belongs to the VM's project, not to a checkout. That is why the commands live in the
# tracked, reviewable tools/check.conf and are copied here rather than hand-edited: a hand-edit and a
# stale install are indistinguishable from the files alone (agents-factory records the same lesson for its
# own tools/check-cmd.sh).
#
# Usage:  bash tools/install-gate.sh [target]     # default target: ${FLEET_CHECK_CONF:-$HOME/.fleet/check.conf}
#
# It is deliberately loud about replacing an existing, DIFFERENT configuration: on a VM that also holds
# another project's checkout, installing this repo's gates takes that project's gates away (a project VM is
# normally one project per VM, so this is the expected install, not a surprise).
set -euo pipefail
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
SRC="$HERE/check.conf"
DST="${1:-${FLEET_CHECK_CONF:-$HOME/.fleet/check.conf}}"

[ -f "$SRC" ] || { echo "install-gate: no $SRC" >&2; exit 1; }

# REFUSE TO INSTALL A check.conf THAT IS NOT ON MAIN (agent-do-llc, a recurrence of agent-do-ewz).
# The installed file is MACHINE-GLOBAL and outlives the branch it came from: on 2026-10-26 a lane installed
# this repo's config from an UNLANDED branch, the branch stalled pre-merge, and the VM ran a gate config
# (960 s / SUITE_BOUND=880) that main (480 s / 400 s) and main's tests did not describe — the config the
# gate obeyed was untested and the config the tests pinned was not in force. One source of truth: install
# from main, or say loudly that you are deliberately installing unlanded work and reconcile after landing.
#
# The escape hatch exists because of a chicken-and-egg: fleet-check reads the INSTALLED config, so a branch
# that changes check.conf cannot be gate-tested until its config is installed. That is a deliberate,
# temporary divergence — set INSTALL_GATE_ALLOW_UNLANDED=1, and reconcile (re-install from main) the moment
# the branch lands or dies. A provenance sidecar records what was installed; the conf itself is never
# touched, so `diff tools/check.conf ~/.fleet/check.conf` stays the reconciliation check.
REPO_ROOT=$(cd "$HERE/.." && pwd)
MAIN_CONF=$(git -C "$REPO_ROOT" show "origin/main:${SRC#"$REPO_ROOT"/}" 2>/dev/null) || MAIN_CONF=""
# agent-do-fqv: an UNCOMPARABLE source fails CLOSED too. Warning-and-installing let the refusal be bypassed
# by any shallow/missing-ref checkout (git init with no origin/main) or a file main does not have — exactly
# the silent-divergence hole the guard exists to close. Unverifiable is treated like unlanded: refused
# without the override, loud with it, and the provenance says it could not be checked.
COMPARABLE=1
[ -z "$MAIN_CONF" ] && COMPARABLE=0
if [ "$COMPARABLE" = 0 ] || ! printf '%s\n' "$MAIN_CONF" | cmp -s - "$SRC"; then
  if [ "${INSTALL_GATE_ALLOW_UNLANDED:-0}" != 1 ]; then
    if [ "$COMPARABLE" = 0 ]; then
      echo "install-gate: REFUSING: cannot compare $SRC against origin/main here (not a git checkout, the remote" >&2
      echo "install-gate: ref is missing, or main has no such file) — an UNVERIFIABLE source fails CLOSED (agent-do-fqv)." >&2
    else
      echo "install-gate: REFUSING: $SRC differs from origin/main's copy — this checkout carries an UNLANDED gate config." >&2
    fi
    echo "install-gate: the installed file is machine-global; installing unlanded work makes the live gate config" >&2
    echo "install-gate: untested and untracked by main (agent-do-llc, recurrence of agent-do-ewz). Land it first," >&2
    echo "install-gate: or install deliberately with INSTALL_GATE_ALLOW_UNLANDED=1 and reconcile after landing." >&2
    if [ "$COMPARABLE" = 1 ]; then
      printf '%s\n' "--- origin/main" "+++ $SRC" >&2
      diff -u <(printf '%s\n' "$MAIN_CONF") "$SRC" | sed 's/^/  /' >&2 || true
    fi
    exit 1
  fi
  if [ "$COMPARABLE" = 0 ]; then
    echo "install-gate: INSTALL_GATE_ALLOW_UNLANDED=1 — installing a config that CANNOT BE COMPARED to origin/main" >&2
    echo "install-gate: (no git checkout / missing ref / file absent from main): it is UNVERIFIED (agent-do-fqv)." >&2
  else
    echo "install-gate: INSTALL_GATE_ALLOW_UNLANDED=1 — installing a config that DIFFERS FROM origin/main:" >&2
    diff -u <(printf '%s\n' "$MAIN_CONF") "$SRC" | sed 's/^/  /' >&2 || true
  fi
  echo "install-gate: this VM now runs gate bounds main does not describe; reconcile (re-install from main)" >&2
  echo "install-gate: the moment this branch lands or dies (agent-do-llc)." >&2
fi

if [ -f "$DST" ] && ! cmp -s "$SRC" "$DST"; then
  echo "install-gate: replacing an existing, DIFFERENT $DST:" >&2
  diff -u "$DST" "$SRC" | sed 's/^/  /' >&2 || true
fi

mkdir -p "$(dirname "$DST")"
cp "$SRC" "$DST"
chmod 644 "$DST"
# Provenance sidecar (agent-do-llc): what was installed, from where, and whether it matched main at the time.
{
  echo "installed: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "source: $SRC"
  echo "repo_head: $(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "repo_branch: $(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  if [ "$COMPARABLE" = 1 ]; then
    printf '%s\n' "$MAIN_CONF" | cmp -s - "$SRC" && echo "matches_origin_main: yes" || echo "matches_origin_main: NO (INSTALL_GATE_ALLOW_UNLANDED=${INSTALL_GATE_ALLOW_UNLANDED:-0})"
  else
    echo "matches_origin_main: NO — UNVERIFIABLE (origin/main or the file is not readable here; installed via INSTALL_GATE_ALLOW_UNLANDED=${INSTALL_GATE_ALLOW_UNLANDED:-0}, agent-do-fqv)"
  fi
} > "$DST.provenance" 2>/dev/null || true
printf 'install-gate: installed %s -> %s\n' "$SRC" "$DST"
printf 'install-gate: CHECK_CMD=%s\n' "$(grep -c '^CHECK_CMD=' "$DST")"
printf 'install-gate: CHECK_FAST_CMD=%s\n' "$(grep -c '^CHECK_FAST_CMD=' "$DST")"
