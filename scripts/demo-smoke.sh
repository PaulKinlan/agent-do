#!/usr/bin/env bash
# scripts/demo-smoke.sh — the credential-free demo check (AGENTS.md rule 3; CI job "Demo smoke (no credentials)").
#
# WHY IT EXISTS: every demo imports `agent-do` through the workspace link (`"agent-do": "file:../../"`), so the
# demos are the only thing that exercises the PUBLISHED EXPORT SURFACE the way a real consumer does. Every demo
# sat broken for months importing `createFileTools` after it stopped being exported, because nothing ran them.
#
# WHAT IT ASSERTS: each demo gets past module resolution and top-level setup and stops at its own credential
# check ('No provider API key found'). It does NOT exercise the agent loop — that needs real keys and costs
# money, which is exactly why the keys are scrubbed below rather than merely "not set in CI".
#
# Usage:  bash scripts/demo-smoke.sh [demo-dir ...]     # default: every demos/*/ that has a package.json
# Exit:   0 when every demo reached the credential check; 1 otherwise, with the first lines of output of each
#         demo that did not.
set -uo pipefail

HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
cd "$ROOT"

# Scrub the provider environment: a smoke test must never make a real API call, even on a machine that has
# keys exported (it would spend money AND would skip the credential check it is here to verify). DEMO_PROVIDER
# goes too: with it set and no key the demos exit on a different message, which would read as a false failure.
# `unset` here affects only this script and its children.
unset ANTHROPIC_API_KEY GOOGLE_GENERATIVE_AI_API_KEY GOOGLE_API_KEY GEMINI_API_KEY OPENAI_API_KEY DEMO_PROVIDER

[ -d "$ROOT/node_modules" ] || {
  echo "demo-smoke: no node_modules at $ROOT — run 'npm install' at the repo root first (the demos are npm" >&2
  echo "demo-smoke: workspaces and share that one install; there is no per-demo install any more)." >&2
  exit 2
}

# The demos resolve the library through the root self-link `node_modules/agent-do -> ..`, which `npm install`
# creates because a workspace member depends on the root package. `fleet-deps` cannot: it builds its store
# entry with `npm ci` in a directory holding only package.json + the lockfile, so npm never sees `demos/`
# and creates neither the member links nor that self-link (verified 2026-10-12: the store entry has
# agent-do-changelog-formatter and nothing else). Repair that ONE link here — byte for byte what npm makes —
# instead of failing five times with ERR_MODULE_NOT_FOUND. It is a no-op after any real install, and the
# fleet's own fix belongs in fleet-deps (reported). Any other missing link is left alone: this is not a
# fallback installer.
if [ ! -e "$ROOT/node_modules/agent-do" ]; then
  if ln -sfn .. "$ROOT/node_modules/agent-do" 2>/dev/null; then
    echo "demo-smoke: node_modules/agent-do was missing (fleet-deps store entries cannot create workspace" >&2
    echo "demo-smoke: links); linked it to the repo root, which is what npm install creates." >&2
  fi
fi

# The demos import the BUILT library (`agent-do` resolves to dist/src/index.js through the package exports),
# so without a build every demo dies with ERR_MODULE_NOT_FOUND naming a path inside dist/. Say that once
# instead of five times: the gates and CI both build first, but a hand-run in a fresh worktree does not.
[ -f "$ROOT/dist/src/index.js" ] || {
  echo "demo-smoke: the library is not built ($ROOT/dist/src/index.js is missing) — run 'npm run build'" >&2
  echo "demo-smoke: first; the demos import the package, not the TypeScript sources." >&2
  exit 2
}

demos=("$@")
if [ "${#demos[@]}" -eq 0 ]; then
  demos=()
  for dir in demos/*/; do
    [ -f "${dir}package.json" ] || continue
    demos+=("${dir%/}")
  done
fi
[ "${#demos[@]}" -gt 0 ] || { echo "demo-smoke: no demos found under $ROOT/demos" >&2; exit 2; }

rc=0
for demo in "${demos[@]}"; do
  name=$(basename "$demo")
  printf '── %s ──\n' "$name"
  # `timeout` so a hung demo cannot hold the gate; stdin from /dev/null because several demos read a prompt.
  out=$( cd "$demo" && timeout 120 npx tsx index.ts </dev/null 2>&1 || true )
  if printf '%s' "$out" | grep -q 'No provider API key found'; then
    printf 'OK — %s initialised and stopped at the credential check.\n' "$name"
  else
    printf '::error::Demo %s failed before the credential check:\n' "$name"
    printf '%s\n' "$out" | head -20
    rc=1
  fi
done
exit "$rc"
