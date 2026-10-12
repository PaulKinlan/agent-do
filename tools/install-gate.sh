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

if [ -f "$DST" ] && ! cmp -s "$SRC" "$DST"; then
  echo "install-gate: replacing an existing, DIFFERENT $DST:" >&2
  diff -u "$DST" "$SRC" | sed 's/^/  /' >&2 || true
fi

mkdir -p "$(dirname "$DST")"
cp "$SRC" "$DST"
chmod 644 "$DST"
printf 'install-gate: installed %s -> %s\n' "$SRC" "$DST"
printf 'install-gate: CHECK_CMD=%s\n' "$(grep -c '^CHECK_CMD=' "$DST")"
printf 'install-gate: CHECK_FAST_CMD=%s\n' "$(grep -c '^CHECK_FAST_CMD=' "$DST")"
