import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // vitest 4 widened its default test-file glob to include compiled
    // output under `dist/`, so a fresh `npm run build` seeded shadow
    // copies of every test into the runner. Restrict discovery to the
    // source test tree and the handful of historical test-lookalike
    // paths we actually ship.
    include: ['tests/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
});
