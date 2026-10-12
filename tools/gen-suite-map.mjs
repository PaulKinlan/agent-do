#!/usr/bin/env node
/**
 * tools/gen-suite-map.mjs — write (or verify) `tools/suite-map.tsv` from the test import graph.
 *
 * WHY THIS IS GENERATED AND NOT HAND-WRITTEN
 * `tools/suite-map.tsv` is the only place affected-only selection is decided (`docs/speed.md`), and the
 * fleet standard's measured failure mode (`fleet-1n0z`) is a map that *looks* complete: a module with
 * several covering suites, mapped to seven of them, where the seven green suites produced no signal
 * whatsoever about the missing eighth. A hand-maintained map cannot detect that. This script can only
 * promise one half of it — that every module is *named* — so it derives the rows from the code itself:
 * a changed file's suites are the test files that *reach* it through relative imports.
 *
 * One row per module, never a directory-wide glob: with `src/*.ts` a brand-new module would inherit the
 * suites of the modules around it, i.e. it would claim coverage that never existed. With one row per
 * module, a new module that no test reaches is UNMAPPED and `tools/fast-gate.sh` exits non-zero until its
 * author says which suite covers it. That is the whole point of the file.
 *
 * Usage:
 *   node tools/gen-suite-map.mjs           # rewrite tools/suite-map.tsv
 *   node tools/gen-suite-map.mjs --check   # exit 1 (with the drift) if the committed map is stale
 *
 * The drift check runs in `tests/gates.test.ts`, so `--check` is enforced by both gates.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAP = join(ROOT, 'tools', 'suite-map.tsv');

/** Every file under `dir`, as repo-relative POSIX paths. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile()) out.push(relative(ROOT, p));
  }
  return out;
}

// A suite is a file the runner can be pointed at. tests/sandbox/contract.ts is NOT one: it is a helper the
// suites import, and `npx vitest run tests/sandbox/contract.ts` would run no test at all.
const isSuite = (p) => /\.test\.tsx?$/.test(p);

// Every way a module can depend on another one, including vitest's module mocks: `vi.mock('../src/x.js')`
// is a real dependency (the test breaks if that module moves) and is not an `import` statement.
const SPECIFIER_RES = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
  /\bvi\.(?:mock|doMock|importActual|unmock)\s*\(\s*['"]([^'"]+)['"]/g,
];

/**
 * Resolve a specifier the way TypeScript's `bundler` resolution does for this repo: relative paths, source
 * written as `.js` but living as `.ts` (the whole `src/` tree imports `'./x.js'`), plus directory indexes.
 */
function resolveSpecifier(fromRel, spec) {
  if (!spec.startsWith('.')) return null; // node:/bare packages are not repo modules
  const base = resolve(ROOT, dirname(fromRel), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    join(base, 'index.ts'),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return relative(ROOT, c);
  }
  return null;
}

function specifiersOf(file) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const out = new Set();
  for (const re of SPECIFIER_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const target = resolveSpecifier(file, m[1]);
      if (target) out.add(target);
    }
  }
  return out;
}

/** Every repo module reachable from `entry` through relative imports. */
function reachable(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    for (const next of specifiersOf(file)) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

const allFiles = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'tests'))];
const suites = allFiles.filter(isSuite).sort();
const helpers = new Set(allFiles.filter((p) => !isSuite(p)));

const rows = new Map(); // module -> Set<suite>
const unmappedModules = new Set(); // modules nothing reaches: expected, and they stay off the map
for (const suite of suites) {
  for (const file of reachable(suite)) {
    const isModule =
      file.startsWith('src/') || (file.startsWith('tests/') && !isSuite(file) && helpers.has(file));
    if (!isModule) continue;
    if (!rows.has(file)) rows.set(file, new Set());
    rows.get(file).add(suite);
  }
}
for (const file of allFiles) {
  if (!rows.has(file) && !isSuite(file)) unmappedModules.add(file);
}

const lines = [
  '# tools/suite-map.tsv — which suites cover which changed path. The ONLY place affected-only selection',
  '# is decided (docs/speed.md R5: "selection is affected-only, driven by a changed-path -> suite map, and',
  '# the map fails loudly on an unmapped file").',
  '#',
  '# GENERATED by tools/gen-suite-map.mjs — do not hand-edit. The rows come from the test import graph, so',
  '# a module is listed with EVERY suite that reaches it; `node tools/gen-suite-map.mjs --check` (run by',
  '# tests/gates.test.ts, i.e. by both gates) fails when this file is stale.',
  '#',
  '# FORMAT',
  '#   <glob><TAB><suite> [<suite> ...]     a changed path matching <glob> runs those suites',
  '#   !<glob>                              EXEMPT: no suite can cover this path (prose, CI, packaging)',
  '#',
  '# RULES',
  '#   * Globs are bash patterns tested with `[[ $path == $glob ]]`, so `*` also crosses `/`.',
  '#   * A changed test file maps to ITSELF, before this file is consulted (docs/speed.md R14 names',
  '#     "changed test files that do not map to themselves" as a measured defect).',
  '#   * A row beats an exemption (rows are consulted first).',
  '#   * A module that NO suite reaches is deliberately absent: `tools/fast-gate.sh` then FAILS LOUDLY on a',
  '#     change to it. Adding coverage is the fix; an exemption is a claim that no suite can ever cover it.',
  '#   * `package.json`, `package-lock.json` and `vitest.config.ts` are deliberately absent for the same',
  '#     reason. A dependency, lockfile or runner-config change is not a local change — it can reach every',
  '#     suite — so the fast tier refuses it (it must stay a strict subset, R2) and the change is gated by',
  '#     the full tier. See "Changes the fast tier refuses" in docs/speed.md.',
  '',
  '# --- source modules -> every suite that reaches them (generated) -------------------------------------',
];

for (const [file, set] of [...rows.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  lines.push(`${file}\t${[...set].sort().join(' ')}`);
}

lines.push(
  '',
  '# --- the gate is code, and tests/gates.test.ts is its suite -------------------------------------------',
  'tools/*\ttests/gates.test.ts',
  'tests/gates.test.ts\ttests/gates.test.ts',
  '',
  '# --- exemptions: no suite can cover these, and the reason is on the line ------------------------------',
  '!docs/**\t# prose; a wrong doc is a docs-drift finding (the nightly factory line files it), not a test',
  '!**/*.md\t# prose anywhere (README, CHANGELOG, AGENTS/CLAUDE, docs/*, .changeset/*.md)',
  '!*.md',
  '!llms.txt\t# prose for model consumers; kept honest by review, not by a suite',
  '!.github/**\t# CI config: it is exercised by running it, on the platform runner',
  '!.changeset/**\t# release notes (the *.md exemption above covers the payloads)',
  '!LICENSE',
  '!.gitignore',
  '!typedoc.json\t# API-docs build config; exercised by `npm run docs`, a separate CI job (no suite)',
  '!tsconfig.json\t# type-level only: both gates\' STATIC_CMD (npm run build) compiles the whole program',
  '!scripts/**\t# release + changelog formatter tooling; exercised by running a release, not by a suite',
  '!examples/**\t# credential-requiring single-feature examples; run by hand (see AGENTS.md rule 2)',
  '!demos/**\t# consumer-surface smoke: CI job "Demo smoke (no credentials)" runs `tsc`+`tsx` per demo',
  '!evals/**\t# mock-tier evals are one command (`npm run eval`), not per-file suites: full gate + CI',
  '',
);

const generated = lines.join('\n');
const mode = process.argv.includes('--check') ? 'check' : 'write';

if (mode === 'check') {
  const current = existsSync(MAP) ? readFileSync(MAP, 'utf8') : '';
  if (current === generated) {
    console.log(`suite-map: in sync (${rows.size} module row(s), ${suites.length} suite(s))`);
    process.exit(0);
  }
  const currentLines = new Set(current.split('\n'));
  const generatedLines = new Set(generated.split('\n'));
  const added = [...generatedLines].filter((l) => !currentLines.has(l));
  const removed = [...currentLines].filter((l) => !generatedLines.has(l));
  console.error('suite-map: STALE - tools/suite-map.tsv does not match the test import graph.');
  for (const l of removed) console.error(`  - ${l}`);
  for (const l of added) console.error(`  + ${l}`);
  console.error('  Fix: node tools/gen-suite-map.mjs');
  process.exit(1);
}

writeFileSync(MAP, generated);
console.log(
  `suite-map: wrote ${rows.size} module row(s) for ${suites.length} suite(s)` +
    (unmappedModules.size > 0
      ? `; ${unmappedModules.size} module(s) unlocked by any suite stay off the map:\n  ${[...unmappedModules].sort().join('\n  ')}`
      : ''),
);
