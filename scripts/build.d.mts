/**
 * Type declarations for scripts/build.mjs (agent-do-lve).
 *
 * The repo compiles with allowJs off, so tests/build-script.test.ts importing the
 * .mjs wrapper needs these declarations to type-check (TS7016 otherwise). The
 * wrapper is a build-time tool: it is executed by `npm run build`, never shipped
 * (package.json `files` does not include scripts/), and only these two pure
 * helpers are imported anywhere.
 */

/** The single tsbuildinfo path tsc uses for the build rooted at cwd. */
export function tsbuildinfoPath(tsconfig?: unknown): string;

/**
 * Repo-relative artifact paths the package's consumers import — the union of
 * `main`, `types`, `bin`, and every string leaf of `exports`. Empty when the
 * package manifest is unreadable.
 */
export function verifyTargets(pkg?: unknown): string[];
