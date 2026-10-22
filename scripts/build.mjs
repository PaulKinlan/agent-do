#!/usr/bin/env node
/**
 * scripts/build.mjs — incremental-safe wrapper around `tsc` for `npm run build` (agent-do-lve).
 *
 * WHY THIS EXISTS
 * `"incremental": true` (tsconfig.json) makes tsc skip emit for files it believes are current
 * according to `dist/tsconfig.tsbuildinfo`. If a build is killed part-way through its emit —
 * the exact failure mode the incremental change exists to survive: gate bounds SIGTERM long
 * builds — dist/ is left truncated while the PREVIOUS build's tsbuildinfo still matches every
 * input hash. The next `tsc` then re-emits nothing and exits 0: a silently wrong artifact in
 * the directory the demos import (`file:../../`), CI smoke-runs, and npm publishes. The test
 * suites cannot catch it because they import `src/`, not `dist/`.
 *
 * Three behaviours over plain tsc:
 *
 *   1. SIGTERM / SIGINT / SIGHUP delete the tsbuildinfo on the way out, so the next build is
 *      a FULL emit that repairs dist. After a kill we cannot trust what landed on disk, and
 *      the tsbuildinfo on disk describes the PREVIOUS build, not this one.
 *   2. A tsc exit 0 is verified against the package's real consumers: every target named by
 *      `main` / `types` / `bin` / `exports` must exist and be non-empty. When the emit was
 *      skipped or truncated, that is where it shows.
 *   3. If verification fails, the tsbuildinfo is deleted and tsc runs once more (now a full
 *      emit), then verification runs again. This self-heals the stale-record case where tsc
 *      legitimately believes everything is current. Still failing → exit 1, loudly.
 *
 * Env overrides (used by tests/build-script.test.ts):
 *   BUILD_SCRIPT_TSC    command string to run instead of `node_modules/.bin/tsc`.
 *   BUILD_SCRIPT_VERIFY comma-separated repo-relative paths to verify instead of the
 *                       targets parsed from package.json (fixture projects).
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();

function readJsonIfExists(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * The single tsbuildinfo path tsc uses for this build: the explicit
 * `compilerOptions.tsBuildInfoFile` when set, else the tsc default of
 * `<outDir>/tsconfig.tsbuildinfo`.
 */
export function tsbuildinfoPath(tsconfig = readJsonIfExists(join(ROOT, 'tsconfig.json'))) {
  const co = tsconfig?.compilerOptions ?? {};
  if (typeof co.tsBuildInfoFile === 'string') return resolve(ROOT, co.tsBuildInfoFile);
  const outDir = typeof co.outDir === 'string' ? co.outDir : 'dist';
  return join(ROOT, outDir, 'tsconfig.tsbuildinfo');
}

/** Collect the string leaves of an `exports` object (`default` / `types` / conditions). */
function exportsTargetStrings(node, out) {
  if (typeof node === 'string') {
    out.push(node);
  } else if (node !== null && typeof node === 'object') {
    for (const value of Object.values(node)) exportsTargetStrings(value, out);
  }
}

/**
 * Repo-relative artifact paths the package's consumers actually import — the union of
 * `main`, `types`, `bin`, and every string leaf of `exports`. These are what a truncated
 * emit breaks first, so they are what "the build succeeded" must mean.
 */
export function verifyTargets(pkg = readJsonIfExists(join(ROOT, 'package.json'))) {
  const targets = new Set();
  if (!pkg || typeof pkg !== 'object') return [];
  for (const field of ['main', 'types']) {
    if (typeof pkg[field] === 'string') targets.add(pkg[field]);
  }
  const bin = pkg.bin;
  if (typeof bin === 'string') targets.add(bin);
  else if (bin !== null && typeof bin === 'object') {
    for (const value of Object.values(bin)) {
      if (typeof value === 'string') targets.add(value);
    }
  }
  if (pkg.exports !== undefined) {
    const leaves = [];
    exportsTargetStrings(pkg.exports, leaves);
    for (const leaf of leaves) targets.add(leaf);
  }
  return [...targets]
    .map((t) => t.replace(/^\.\//, ''))
    .filter((t) => t.length > 0)
    // main/types and exports may name the SAME artifact ('dist/src/index.js' and
    // './dist/src/index.js'); dedupe after normalisation so the list is a set.
    .filter((t, i, arr) => arr.indexOf(t) === i);
}

function verifyList() {
  if (process.env.BUILD_SCRIPT_VERIFY !== undefined) {
    return process.env.BUILD_SCRIPT_VERIFY.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return verifyTargets();
}

function allPresent(repoRelativePaths) {
  const missing = [];
  for (const rel of repoRelativePaths) {
    const abs = resolve(ROOT, rel);
    let ok = false;
    try {
      ok = statSync(abs).size > 0;
    } catch {
      ok = false;
    }
    if (!ok) missing.push(rel);
  }
  return { ok: missing.length === 0, missing };
}

function runTsc() {
  return new Promise((resolvePromise) => {
    const child = spawn(process.env.BUILD_SCRIPT_TSC ?? 'node_modules/.bin/tsc', {
      shell: true,
      stdio: 'inherit',
    });
    child.on('exit', (code, signal) => resolvePromise(code === null ? (signal ? 1 : 0) : code));
    child.on('error', () => resolvePromise(1));
  });
}

async function main() {
  const infoPath = tsbuildinfoPath();

  // (1) A killed build must not leave a record that says "current". Deleting the
  // tsbuildinfo costs one full rebuild next time; keeping it can cost a silently
  // wrong dist/ forever.
  let exiting = false;
  const onSignal = (sig) => {
    if (exiting) return;
    exiting = true;
    try {
      rmSync(infoPath, { force: true });
    } catch {
      // best effort — the exit code carries the failure signal either way
    }
    process.exit(128 + sig);
  };
  process.on('SIGTERM', () => onSignal(15));
  process.on('SIGINT', () => onSignal(2));
  process.on('SIGHUP', () => onSignal(1));

  // (2) + (3) build, then verify against the package's real consumers; on a failed
  // verification drop the record and rebuild once (full emit) before giving up.
  const checks = verifyList();
  let code = await runTsc();
  if (code !== 0) process.exit(code);

  let result = allPresent(checks);
  if (!result.ok) {
    rmSync(infoPath, { force: true });
    code = await runTsc();
    if (code !== 0) process.exit(code);
    result = allPresent(checks);
    if (!result.ok) {
      // Drop the record here too: the next build must not trust it after two
      // consecutive verifications failed.
      rmSync(infoPath, { force: true });
      console.error(
        `build: dist verification FAILED after a full rebuild — missing or empty: ${result.missing.join(', ')}. ` +
          'The emit is not producing the artifacts package.json promises; do not publish.',
      );
      process.exit(1);
    }
    console.log('build: dist was stale or truncated; a full rebuild repaired it.');
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  await main();
}
