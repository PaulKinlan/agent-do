#!/usr/bin/env bash
#
# End-to-end release script. Intentionally manual — no automated CI
# workflow publishes for us, because that would require a long-lived
# NPM_TOKEN secret sitting in the repo. Instead, the maintainer runs
# this locally after minting a short-lived npm token.
#
# Expected flow:
#   1. Changesets have already been recorded via `npm run changeset`
#      and merged to main (or at least committed on the current branch).
#   2. `npm login` or `NPM_TOKEN=… npm run release` — either way, the
#      current shell needs npm publish credentials.
#   3. `npm run release` — runs this script.
#
# Steps:
#   a. Sanity checks: clean git tree, on a branch that's been pushed,
#      no pending changesets left over.
#   b. Quality gate: typecheck + test + build.
#   c. Apply pending changesets → bumps package.json + writes
#      CHANGELOG.md.
#   d. Commit the bump.
#   e. `changeset publish` — publishes to npm + creates the git tag.
#   f. Push the commit + tag.
#
# Any failure stops the script immediately. Individual steps are
# idempotent enough that you can re-run after fixing the cause.

set -euo pipefail

die() { echo "❌ $*" >&2; exit 1; }
log() { echo "▶ $*"; }

# ── 0. Preconditions ─────────────────────────────────────────────────

[ -z "$(git status --porcelain)" ] || die "Working tree is dirty. Commit or stash first."

current_branch="$(git rev-parse --abbrev-ref HEAD)"
log "Releasing from branch: $current_branch"

# Resolve the changeset binary explicitly instead of going through
# `npx changeset`. npx's resolver can report "could not determine
# executable to run" when the package name doesn't exactly match a
# binary, and `@changesets/cli` is one of those. The local binary
# from `node_modules/.bin` is deterministic and fast.
CHANGESET_BIN="./node_modules/.bin/changeset"
if [ ! -x "$CHANGESET_BIN" ]; then
  log "changeset binary missing at $CHANGESET_BIN; running npm install…"
  npm install --no-audit --no-fund
fi
[ -x "$CHANGESET_BIN" ] || die "Still no $CHANGESET_BIN after npm install. Is @changesets/cli in devDependencies?"

# Count pending changeset files (exclude README.md / config.json).
pending_count="$(find .changeset -maxdepth 1 -name '*.md' ! -name 'README.md' | wc -l | tr -d ' ')"
if [ "$pending_count" -eq 0 ]; then
  die "No pending changesets. Run \`npm run changeset\` to record one first."
fi
log "Found $pending_count pending changeset(s)."

# ── 1. Quality gate ──────────────────────────────────────────────────

log "Running typecheck + tests + build…"
npm run typecheck
npm test
npm run build

# ── 2. Apply changesets — bumps package.json + writes CHANGELOG.md ───

log "Applying pending changesets…"
"$CHANGESET_BIN" version

# Show what's about to be committed so the operator can eyeball it.
git --no-pager diff --stat

# ── 3. Commit the bump ───────────────────────────────────────────────

new_version="$(node -p "require('./package.json').version")"
log "New version: $new_version"

git add -A
git commit -m "chore: release v$new_version"

# ── 4. Publish to npm + create git tag ───────────────────────────────

log "Publishing to npm (provenance enabled)…"
NPM_CONFIG_PROVENANCE=true "$CHANGESET_BIN" publish

# ── 5. Push commit + tags ────────────────────────────────────────────

log "Pushing commit + tags to origin/$current_branch…"
git push origin "$current_branch" --follow-tags

log "✅ Release v$new_version complete."
echo
echo "Next steps:"
echo "  - Open https://github.com/PaulKinlan/agent-do/releases to verify the tag"
echo "  - (Optional) Create a GitHub release from the tag with the CHANGELOG entry"
