/**
 * Browser entry (GH #139, agent-do-5ep) — the acceptance check.
 *
 * The issue's acceptance is not "a `./browser` export exists", it is: **build with builtin imports
 * forbidden, and no global `process` shim**. That is a property of the whole transitive graph, so it
 * cannot be held by a doc comment — any import added anywhere in reachable code can break it, silently,
 * long after the change that did it. This file therefore checks the property the way a bundler would:
 * it walks the real import graph from `src/browser.ts` and fails on a reachable `node:` specifier, a bare
 * `process.x`, `require(`, `__dirname` or `import.meta.url`.
 *
 * Two details matter for the walk to be worth anything:
 *
 * 1. `import type` / `export type` edges are NOT followed. They are erased before a bundler sees them, so
 *    treating them as runtime edges reports failures that no browser build would hit — the first version
 *    of this analysis flagged `types.ts -> mcp.ts` for exactly that reason and was wrong.
 * 2. Comments and string/template literals are removed before scanning for `process`. `src/usage.ts`
 *    explains in a comment that *"browsers don't have process.stderr"* and then reads it through
 *    `globalThis` with an explicit `?.` guard; a naive grep reports the prose, and the guarded read works
 *    without a shim, so both must pass.
 *
 * The third group of tests is the other half of the contract: the Node entry must keep everything it
 * exported before (the issue says "preserve native Node exports"), so each split is checked from both
 * sides — present in `src/index.ts`, absent from `src/browser.ts`.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as browserEntry from '../src/browser.js';
import { buildOnStepEnd, runAgentLoop, streamAgentLoop } from '../src/loop.js';
import * as nodeEntry from '../src/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const BROWSER_ENTRY = join(SRC, 'browser.ts');

/** Remove comments so prose about `process.stderr` is not mistaken for code. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/gm, '$1');
}

/** Blank string and template literals so their contents are not read as identifiers. */
function blankStrings(source: string): string {
  return source
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

/** A runtime import/export-from, or a dynamic import with a literal specifier. */
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([^;\n]*?)\s*from\s*['"]([^'"]+)['"]|(?<!["'\w])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

interface Offender {
  what: string;
  via: string[];
}

interface Graph {
  modules: Set<string>;
  offenders: Offender[];
  bareSpecifiers: Set<string>;
}

/**
 * Walk runtime imports from `entry`, collecting every reachable module, every Node-only reference, and
 * every bare package specifier (so the test can check that no *dependency* drags Node code in either).
 */
function analyse(entry: string): Graph {
  const modules = new Set<string>();
  const offenders: Offender[] = [];
  const bareSpecifiers = new Set<string>();

  const visit = (file: string, via: string[]): void => {
    if (modules.has(file)) return;
    modules.add(file);

    const code = stripComments(readFileSync(file, 'utf8'));
    const chain = [...via, relative(ROOT, file)];

    for (const match of code.matchAll(IMPORT_RE)) {
      const isTypeOnly = Boolean(match[1]);
      const specifier = match[3] ?? match[4];
      if (!specifier) continue;
      if (isTypeOnly) continue; // erased before a bundler sees it
      if (specifier.startsWith('node:')) {
        offenders.push({ what: `${specifier}${match[4] ? ' (dynamic)' : ''}`, via: chain });
      } else if (specifier.startsWith('.')) {
        visit(resolve(dirname(file), specifier).replace(/\.js$/, '.ts'), chain);
      } else {
        bareSpecifiers.add(specifier);
      }
    }

    const codeNoStrings = blankStrings(code);
    for (const match of codeNoStrings.matchAll(
      /(?<![\w.$])process\.(env|argv|stdout|stderr|stdin|cwd|exit|platform)/g,
    )) {
      // `typeof process` and `globalThis[...].process` are the shim-free ways to reach it, so allow them.
      const near = codeNoStrings.slice(Math.max(0, match.index - 200), match.index + 200);
      if (!/typeof\s+process|globalThis[\s\S]{0,80}\.process/.test(near)) {
        offenders.push({ what: `bare process.${match[1]}`, via: chain });
      }
    }
    for (const match of codeNoStrings.matchAll(/(?<![\w.$])(require\s*\(|__dirname|import\.meta\.url)/g)) {
      offenders.push({ what: match[1], via: chain });
    }
  };

  visit(entry, []);
  return { modules, offenders, bareSpecifiers };
}

const graph = analyse(BROWSER_ENTRY);

describe('the browser entry graph, walked the way a bundler follows it', () => {
  it('contains no Node builtin, no bare process access, no require/__dirname/import.meta.url', () => {
    const report = graph.offenders
      .map((offender) => `  ${offender.what}\n      via ${offender.via.join(' -> ')}`)
      .join('\n');
    expect(
      graph.offenders,
      `the browser entry pulls Node-only code (GH #139 acceptance: "build with builtin imports ` +
        `forbidden and no global process shim"):\n${report}`,
    ).toEqual([]);
  });

  it('reaches the real implementations rather than stubs', () => {
    // "retaining real loop, in-memory routines, cron validation and remote MCP" - if any of these is
    // missing, the entry has been hollowed out and the graph assertions above become trivial.
    for (const required of [
      'src/loop.ts',
      'src/routines.ts',
      'src/scheduled-tasks.ts',
      'src/mcp.ts',
    ]) {
      expect(graph.modules.has(join(ROOT, required)), `${required} must be reachable`).toBe(true);
    }
  });

  it('keeps every Node-only half out of the graph', () => {
    for (const forbidden of [
      'src/routines/filesystem.ts', // node:fs
      'src/scheduled-tasks/fs.ts', // node:fs + the #15 lock
      'src/stores/file-lock.ts', // node:os + node:crypto
      'src/stores/sandbox.ts', // node:fs (host connector)
      'src/tools/shell-tool.ts', // node:child_process
      'src/tools/workspace-tools.ts', // node:child_process via the host connector
      'src/agent.ts', // composes the Node-only tools and the scheduled-task runner
      'src/index.ts', // the Node entry itself
    ]) {
      expect(
        graph.modules.has(join(ROOT, forbidden)),
        `${forbidden} must NOT be reachable from the browser entry`,
      ).toBe(false);
    }
  });

  it('imports no MCP client transport that pulls Node streams', () => {
    // The remote transports are safe; the stdio one pulls `cross-spawn`, `node:process` and `node:stream`.
    // `src/mcp.ts` imports it dynamically through an indirect specifier so bundlers cannot follow it, which
    // also means the walk above cannot see it - so check the SDK files we DO import, directly.
    const sdkRoot = join(ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/esm');
    const sdkSpecifiers = [...graph.bareSpecifiers].filter((specifier) =>
      specifier.startsWith('@modelcontextprotocol/sdk/'),
    );
    expect(sdkSpecifiers.length, 'the entry should mount MCP over the SDK').toBeGreaterThan(0);
    for (const specifier of sdkSpecifiers) {
      const file = join(sdkRoot, specifier.slice('@modelcontextprotocol/sdk/'.length));
      expect(existsSync(file), `${specifier} should resolve inside the published SDK`).toBe(true);
      const code = stripComments(readFileSync(file, 'utf8'));
      expect(code, `${specifier} must not import a Node builtin`).not.toMatch(/from\s*['"]node:/);
      expect(code, `${specifier} must not spawn a process`).not.toMatch(/['"]cross-spawn['"]/);
    }
  });
});

describe('what the browser entry exports', () => {
  it('is the real loop, not a reimplementation', () => {
    expect(browserEntry.runAgentLoop).toBe(runAgentLoop);
    expect(browserEntry.streamAgentLoop).toBe(streamAgentLoop);
    expect(browserEntry.buildOnStepEnd).toBe(buildOnStepEnd);
  });

  it('validates cron expressions without touching the host', () => {
    // Local-time construction so the assertion is timezone independent.
    expect(browserEntry.matchesCron('*/5 * * * *', new Date(2026, 0, 1, 0, 5, 0))).toBe(true);
    expect(browserEntry.matchesCron('*/5 * * * *', new Date(2026, 0, 1, 0, 7, 0))).toBe(false);
    expect(() =>
      browserEntry.validateScheduledTasks([{ id: 'ok', cron: '*/5 * * * *', payload: 'run' }]),
    ).not.toThrow();
    expect(() =>
      browserEntry.validateScheduledTasks([{ id: 'bad', cron: 'not a cron', payload: 'run' }]),
    ).toThrow();
  });

  it('round-trips routines through the in-memory store', async () => {
    const store = new browserEntry.InMemoryRoutineStore();
    await store.save({
      id: 'daily',
      name: 'Daily',
      description: 'Every day',
      body: 'Summarise {{topic}}.',
      runCount: 0,
    });
    expect((await store.get('daily'))?.body).toBe('Summarise {{topic}}.');
    await store.recordRun('daily');
    expect((await store.get('daily'))?.runCount).toBe(1);
    await store.remove('daily');
    expect(await store.get('daily')).toBeUndefined();
    // The Node-only store must not be reachable from this entry.
    expect('FilesystemRoutineStore' in browserEntry).toBe(false);
  });

  it('mounts remote MCP and refuses stdio with an actionable error', async () => {
    expect('mountMcpServers' in browserEntry).toBe(false);
    await expect(
      browserEntry.mountRemoteMcpServers([
        { name: 'local', transport: { type: 'stdio', command: 'node' } },
      ]),
    ).rejects.toThrow(/stdio transport[\s\S]*'http' or 'sse'/);
  });
});

describe('version metadata', () => {
  it('pins the MCP client version to package.json instead of reading it with node:module', () => {
    // `src/mcp.ts` used `createRequire(import.meta.url)` for this, which made the module - and everything
    // importing it - depend on a Node builtin. A literal is only safe if drift is caught, so it is caught.
    const literal = /const LIB_VERSION = '([^']+)'/.exec(readFileSync(join(SRC, 'mcp.ts'), 'utf8'));
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    expect(literal?.[1], 'LIB_VERSION must be a literal in src/mcp.ts').toBeTruthy();
    // A release that bumps package.json must move this literal in the same commit. The message says so
    // explicitly, because this failure will otherwise arrive in a release PR where the cause is non-obvious.
    expect(
      literal?.[1],
      `src/mcp.ts must carry const LIB_VERSION = '${pkg.version}'; (it is a literal so this module needs no ` +
        `node:module; update it in the same commit as the version bump)`,
    ).toBe(pkg.version);
  });
});

describe('the Node entry keeps what it exported before', () => {
  // "preserve native Node exports" - each split moved code, so both sides are checked.
  it.each([
    'FilesystemRoutineStore',
    'matchesCron',
    'validateScheduledTasks',
    'readStatus',
    'writeStatus',
    'recordRun',
    'runScheduledTask',
    'mountMcpServers',
  ])('src/index.ts still exports %s', (name) => {
    expect((nodeEntry as unknown as Record<string, unknown>)[name]).toBeDefined();
  });

  it.each(['readStatus', 'writeStatus', 'recordRun', 'runScheduledTask'])(
    'src/browser.ts deliberately does not export %s',
    (name) => {
      expect(name in browserEntry).toBe(false);
    },
  );
});
