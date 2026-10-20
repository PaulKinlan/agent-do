#!/usr/bin/env node
/**
 * tools/bench-redact-cost.mjs — what `redactToolOutputBlocksInString` costs on malformed input.
 *
 * WHY THIS IS HERE AND NOT IN `tests/loop-history.test.ts` (agent-do-t23)
 * The regression this watches for (agent-do-ztb) is a *shape* change, not a wrong answer: finding the
 * matching `</tool_output>` with a backwards `lastIndexOf` per opening tag made a body of M openers with
 * no closers O(M·N) — 1,491 ms at 20,000 openers and 9,724 ms at 40,000 on this 2-vCPU VM, against ~8 ms
 * and ~21 ms for the shipped precomputed-close-positions + binary-search walk.
 *
 * Pinning that with a wall-clock assertion inside the fast gate is the P3 pathology in `docs/speed.md`
 * §6: a *suite* may not assert on the machine, because on a loaded shared VM it turns a tree that did not
 * change red. So the suite keeps the deterministic half of the contract (the same large inputs must come
 * back unchanged, by reference) and the cost lives here, where nothing in the fleet's critical path is
 * waiting on it. Neither `tools/fast-gate.sh` nor `tools/full-gate.sh` runs this file.
 *
 * Usage:  npx tsx tools/bench-redact-cost.mjs
 *
 * Exit code 1 only on a gross regression: the bound carries ~40x the measured cost, so a busy VM still
 * passes and only a return to the quadratic walk trips it.
 */

import { redactToolOutputBlocksInString } from '../src/loop-history.ts';

/** The number the old quadratic walk missed by 19x at 40,000 openers; the linear walk needs ~21 ms. */
const BOUND_MS = 750;
const ROUNDS = 3;

/** Best-of-`ROUNDS` wall clock, in ms — best-of, because noise on a shared VM can only add time. */
function best(fn) {
  let bestMs = Infinity;
  let result;
  for (let round = 0; round < ROUNDS; round++) {
    const started = performance.now();
    result = fn();
    bestMs = Math.min(bestMs, performance.now() - started);
  }
  return { ms: bestMs, result };
}

function unbalanced(openers) {
  const input = '<tool_output>'.repeat(openers);
  const { ms, result } = best(() => redactToolOutputBlocksInString(input));
  // Same contract the suite asserts: nothing is redactable, so the same reference comes back.
  if (result !== input) throw new Error(`unbalanced(${openers}) rewrote a body with no closers`);
  return { label: `unbalanced openers ${openers.toLocaleString('en-US')}`, units: openers, ms };
}

function balanced(blocks) {
  const block = '<tool_output tool="read_file" path="a.txt">\nsecret\n</tool_output>';
  const input = block.repeat(blocks);
  const { ms, result } = best(() => redactToolOutputBlocksInString(input));
  const expected = '<tool_output tool="read_file" path="a.txt" redacted="stale"/>'.repeat(blocks);
  if (result !== expected) throw new Error(`balanced(${blocks}) did not redact every block`);
  return { label: `balanced blocks ${blocks.toLocaleString('en-US')}`, units: blocks, ms };
}

const rows = [unbalanced(10_000), unbalanced(20_000), unbalanced(40_000), balanced(20_000)];

const width = Math.max(...rows.map((r) => r.label.length));
console.log(`redactToolOutputBlocksInString — best of ${ROUNDS}, ${process.version}, ${process.arch}`);
for (const row of rows) {
  const perUnit = ((row.ms / row.units) * 1e6).toFixed(0);
  console.log(`  ${row.label.padEnd(width)}  ${row.ms.toFixed(1).padStart(9)} ms  ${perUnit.padStart(6)} ns/unit`);
}

const malformed40k = rows.find((r) => r.label.includes('40,000'));
if (malformed40k.ms > BOUND_MS) {
  console.error(
    `\nbench-redact: FAIL — 40,000 unbalanced openers took ${malformed40k.ms.toFixed(0)} ms, bound is ${BOUND_MS} ms.` +
      '\nThe close search is probably back to a backwards scan per opener (agent-do-ztb).' +
      '\nCompare against the precomputed close positions + binary search in src/loop-history.ts.',
  );
  process.exit(1);
}
console.log(`\nbench-redact: OK — 40,000 unbalanced openers ${malformed40k.ms.toFixed(0)} ms (bound ${BOUND_MS} ms).`);
