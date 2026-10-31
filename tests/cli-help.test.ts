// @reads src/cli.ts
// @reads src/cli/args.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `--help` and the argument parser are two lists that must agree, and nothing checked that they did.
 *
 * This exists because `src/cli.ts` had no suite at all: the generated map reported it as a module nothing
 * reaches, so any change to the CLI's help text was unmapped and the fast gate refused the branch
 * (agent-do-5re, which added `--trust-agent-config` and hit exactly that). A pure "map it somehow" fix would
 * have been a marker with no test behind it; this is the test that menu belongs to.
 *
 * It reads both files as DATA (`@reads`), because `src/cli.ts` runs `main()` on import — the only way to
 * exercise it without executing the CLI is to inspect its source.
 */

const ROOT = join(import.meta.dirname, '..');
const cliSource = readFileSync(join(ROOT, 'src/cli.ts'), 'utf8');
const argsSource = readFileSync(join(ROOT, 'src/cli/args.ts'), 'utf8');

/** The `printHelp` template literal, i.e. exactly what `npx agent-do --help` prints. */
function helpText(): string {
  const start = cliSource.indexOf('function printHelp');
  expect(start, 'printHelp must exist in src/cli.ts').toBeGreaterThan(-1);
  const open = cliSource.indexOf('`', start);
  const close = cliSource.indexOf('`', open + 1);
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return cliSource.slice(open + 1, close);
}

/** Every flag the parser accepts, harvested from `arg === '…'` comparisons. */
function acceptedFlags(): Set<string> {
  const flags = new Set<string>();
  for (const match of argsSource.matchAll(/arg === '(--?[a-z-]+)'/g)) flags.add(match[1]!);
  return flags;
}

/**
 * Flags that change what the agent is allowed to DO. These must be discoverable in `--help`: an operator who
 * cannot see the switch cannot use it, and the security posture of a run is decided by exactly these.
 *
 * Deliberately not "every flag": `--tasks` is a scheduled-tasks option and `--working-dir` is an alias for
 * `--cwd`, so requiring them in the top-level options block would force the help to grow noise.
 */
const MUST_BE_DOCUMENTED = [
  '--script',
  '--trust-agent-config',
  '--accept-all',
  '--include-sensitive',
  '--no-tools',
  '--read-only',
  '--exclude',
  '--allow',
  '--provider-tool',
  '--yes',
];

describe('CLI help text', () => {
  it('names every permission- or trust-changing flag the parser accepts', () => {
    const help = helpText();
    const accepted = acceptedFlags();
    for (const flag of MUST_BE_DOCUMENTED) {
      expect(accepted.has(flag), `${flag} is in MUST_BE_DOCUMENTED but the parser does not accept it`).toBe(
        true,
      );
      expect(help, `--help does not document ${flag}`).toContain(flag);
    }
  });

  it('does not document a flag the parser would reject', () => {
    const accepted = acceptedFlags();
    const documented = [...helpText().matchAll(/(?<![a-z-])(--[a-z][a-z-]+)/g)].map((m) => m[1]!);
    expect(documented.length).toBeGreaterThan(0);

    for (const flag of new Set(documented)) {
      // Protocol strings and URLs are not flags: `--help` text mentions none of the `--` in them as an option,
      // and `agent-do --thing` is only a claim about the CLI when the parser accepts it.
      expect(accepted.has(flag), `--help advertises ${flag}, which the parser rejects`).toBe(true);
    }
  });

  it('explains what --trust-agent-config is for, not just that it exists', () => {
    // A bare flag name is not documentation. The whole point is that an operator learns a config or prompt file
    // can arrive with a repository (agent-do-5re, agent-do-e29) and what accepting it means.
    const entry = helpEntry('--trust-agent-config');
    expect(entry).toMatch(/saved agent config/i);
    expect(entry).toMatch(/shellm/i);
    expect(entry).toMatch(/vetted|trust|record|creat|repo/i);
  });

  it('keeps each option entry contiguous, so the entry reader is not fooled by a wrapped line', () => {
    // The reader above is the thing under test here: if it swallowed the following option, the assertions in the
    // case above would pass on someone else's words.
    const entry = helpEntry('--no-tools');
    expect(entry).toContain('--no-tools');
    expect(entry).not.toContain('--verbose');
  });
});

/**
 * The lines belonging to one option: the flag's own line plus its wrapped continuation lines, stopping at the
 * next option or a blank line. Splitting the help with a fixed line count (the previous version of this test) is
 * what broke when the entry grew a line — the test then read the FOLLOWING option's text and failed for a reason
 * that had nothing to do with the flag it claimed to check.
 */
function helpEntry(flag: string): string {
  const lines = helpText().split('\n');
  const start = lines.findIndex((l) => l.trim().startsWith(flag));
  expect(start, `--help has no entry for ${flag}`).toBeGreaterThan(-1);

  const entry = [lines[start]!];
  for (let i = start + 1; i < lines.length; i++) {
    const next = lines[i]!;
    const isOption = /^\s{1,}(--?[a-z][a-z-]*)/.test(next);
    if (next.trim() === '' || isOption || /^\S/.test(next)) break;
    entry.push(next);
  }
  return entry.join('\n');
}
