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
 *   node tools/gen-suite-map.mjs           # rewrite tools/suite-map.tsv + tests/coverage-contract.json
 *   node tools/gen-suite-map.mjs --check   # exit 1 (with the drift) if either committed file is stale
 *
 * It writes TWO files from the one graph, because two consumers decide "was this changed file exercised?"
 * and only one of them is ours:
 *   tools/suite-map.tsv            what OUR gate selects (globs, additive rows, exemptions).
 *   tests/coverage-contract.json   what the FLEET's independent oracle reads. `~/fleet/remote/check-coverage.py`
 *                                  does not read suite-map.tsv: it looks for a test file whose *name*
 *                                  corresponds to the changed file, and with no contract every module whose
 *                                  suite is not eponymous (`src/cli/args.ts` -> `tests/cli-args.test.ts`,
 *                                  every `tools/*.sh` -> `tests/gates.test.ts`) is published in the cached
 *                                  record as `unmapped` at the moment its suites really did run. The
 *                                  contract file is the sanctioned hook for that oracle (it also makes the
 *                                  oracle a mode-(b) check, which the map cannot be: if the gate ever ran
 *                                  fewer suites than the contract names, the record says so).
 *
 * The drift check runs in `tests/gates.test.ts`, so `--check` is enforced by both gates.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAP = join(ROOT, 'tools', 'suite-map.tsv');
const CONTRACT = join(ROOT, 'tests', 'coverage-contract.json');

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

/**
 * Match a repo-relative path against a bash-pattern glob, in the dialect this file documents for its rows:
 * `*` also crosses `/`, so `src/cli/*.ts` means "everything under src/cli".
 */
function matchesGlob(path, glob) {
  const pattern = glob
    .split('')
    .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${pattern}$`).test(path);
}

/**
 * Directories/files a suite reads AS DATA, declared with `// @reads <glob>` in the suite itself.
 *
 * A suite that `readFileSync`s source text and asserts on it has a real dependency the import graph cannot see -
 * so without this, a change to a file it inspects maps to other suites only, and the invariant sits green while it is
 * broken (agent-do-9im: the fast gate passed while `cli-answer-stream.test.ts` failed on `eval-cmd.ts`). The marker
 * lives in the suite that does the reading, so it moves with the test rather than drifting in a sidecar list.
 */
function readsPatterns(suite) {
  const source = readFileSync(join(ROOT, suite), 'utf8');
  return [...source.matchAll(/^\s*\/\/\s*@reads\s+(\S+)\s*$/gm)].map((m) => m[1]);
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
  const reached = reachable(suite);
  // A `// @reads <glob>` declaration is a dependency too: the suite inspects those files as text, so it must be
  // selected when one of them changes, exactly as if it imported them (agent-do-9im).
  for (const pattern of readsPatterns(suite)) {
    for (const file of allFiles) if (matchesGlob(file, pattern)) reached.add(file);
  }
  for (const file of reached) {
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
  '# tests/gates.test.ts, i.e. by both gates) fails when this file is stale. The same graph writes',
  '# tests/coverage-contract.json, which is what the FLEET reads (remote/check-coverage.py does not read this',
  '# file: it matches a changed file to a test whose NAME corresponds, and the contract is its hook).',
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
  '#   * `// @reads <glob>` in a suite adds the files it inspects as DATA (the graph cannot see a readFileSync),',
  '#     e.g. tests/cli-answer-stream.test.ts asserts on the text of every src/cli module (agent-do-9im).',
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
  'tests/coverage-contract.json\ttests/gates.test.ts',
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

// The contract the fleet's coverage oracle reads (see the header): the same graph, as JSON, path -> suites.
// `tools/*` is a fnmatch pattern the oracle applies to the changed path, which is what makes a changed
// gate script resolve to its suite there as well as here.
const contract = {};
for (const [file, set] of [...rows.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  contract[file] = [...set].sort();
}
contract['tools/*'] = ['tests/gates.test.ts'];
const generatedContract = `${JSON.stringify(contract, null, 2)}\n`;

const mode = process.argv.includes('--check') ? 'check' : 'write';

function check(path, expected, label) {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (current === expected) return true;
  const currentLines = new Set(current.split('\n'));
  const expectedLines = new Set(expected.split('\n'));
  console.error(`${label}: STALE - does not match the test import graph.`);
  for (const l of currentLines) if (!expectedLines.has(l)) console.error(`  - ${l}`);
  for (const l of expectedLines) if (!currentLines.has(l)) console.error(`  + ${l}`);
  return false;
}

if (mode === 'check') {
  const mapOk = check(MAP, generated, 'suite-map');
  const contractOk = check(CONTRACT, generatedContract, 'coverage-contract');
  if (mapOk && contractOk) {
    console.log(`suite-map: in sync (${rows.size} module row(s), ${suites.length} suite(s))`);
    process.exit(0);
  }
  console.error('  Fix: node tools/gen-suite-map.mjs');
  process.exit(1);
}

writeFileSync(MAP, generated);
writeFileSync(CONTRACT, generatedContract);
console.log(
  `suite-map: wrote ${rows.size} module row(s) for ${suites.length} suite(s), plus tests/coverage-contract.json` +
    (unmappedModules.size > 0
      ? `; ${unmappedModules.size} module(s) no suite reaches stay off both files:\n  ${[...unmappedModules].sort().join('\n  ')}`
      : ''),
);
