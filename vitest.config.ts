import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // agent-do-tnnc: 30 s global per-test timeout. The vitest 5 s default is a
    // load lottery on this VM (docs/speed.md §4): it false-failed three merger
    // full gates under contention (provider-tool-loop on merged tree b9c2094,
    // loop + resolve-model on 6e506fc) while every explicit bump shipped by
    // beads c26/512/7ja/yuc landed on the same 30 s number. Per-test timeouts
    // bind only failures, so green runs pay nothing; a wedged test now reports
    // at 30 s, still an order of magnitude under the derived SUITE_BOUND.
    // Per-file `{ timeout: ... }` declarations (gates 60-180 s, build-script,
    // cost-runaway, ...) override this and stay.
    testTimeout: 30_000,
    // vitest 4 widened its default test-file glob to include compiled
    // output under `dist/`, so a fresh `npm run build` seeded shadow
    // copies of every test into the runner. Restrict discovery to the
    // source test tree and the handful of historical test-lookalike
    // paths we actually ship.
    include: ['tests/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
});
