/**
 * Browser entry (GH #139, agent-do-5ep) — the acceptance check.
 *
 * The issue's acceptance is: **build with builtin imports forbidden, and no global `process` shim**. That is a
 * property of the whole transitive graph, so it cannot be held by a doc comment — any import added anywhere
 * reachable can break it long after the change that did it.
 *
 * THE GRAPH IS WALKED FROM THE AST, NOT WITH A REGEX (agent-do-9d2). The first version matched
 * `... from '<spec>'` with a regular expression, which silently missed side-effect imports — `import 'node:fs';`
 * is a legal runtime import with no `from` clause — so a module could have added exactly the thing this test
 * exists to forbid and stayed green. Regenerating the same knowledge with a TypeScript AST removes the class:
 * `ImportDeclaration` (with or without a clause), `ExportDeclaration`, `ImportEqualsDeclaration` and dynamic
 * `import(...)` are all visited, and `test('sees every import form a bundler would follow')` pins that with a
 * table of sources, so a future narrowing fails loudly instead of quietly checking less.
 *
 * The identifier scan is AST-based for the same reason: a regular expression over source sees `process` inside
 * comments (`src/usage.ts` explains *"browsers don't have process.stderr"* in prose) and inside type
 * annotations (`{ process?: … }`), and both were false positives in the first version. The AST only reports a
 * `process` identifier that is a FREE reference, so `globalThis.process` and `typeof process` pass by
 * construction — they are the shim-free ways to reach it, which is what the acceptance actually requires.
 *
 * The second group covers the other half of the contract, "preserve native Node exports": every split is checked
 * from both sides — present in `src/index.ts`, absent from `src/browser.ts`.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

import * as browserEntry from '../src/browser.js';
import { buildOnStepEnd, runAgentLoop, streamAgentLoop } from '../src/loop.js';
import { canSpawnStdioMcp } from '../src/mcp.js';
import * as nodeEntry from '../src/index.js';
import type { AgentConfig } from '../src/types.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const BROWSER_ENTRY = join(SRC, 'browser.ts');

/** `true` when the import/export is erased before a bundler sees it (`import type` / `export type`). */
interface Specifier {
  specifier: string;
  typeOnly: boolean;
  dynamic: boolean;
}

function parse(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Every module specifier this file names at runtime: all import/export forms, dynamic imports included. */
function importSpecifiers(fileName: string, source: string): Specifier[] {
  const out: Specifier[] = [];
  const push = (specifier: string, typeOnly: boolean, dynamic: boolean): void => {
    out.push({ specifier, typeOnly, dynamic });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      // Covers `import x from`, `import {a} from`, `import type {...} from` AND the side-effect form
      // `import '<spec>'` — the form the regex version could not see (agent-do-9d2).
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        push(node.moduleSpecifier.text, node.importClause?.isTypeOnly ?? false, false);
      }
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        push(node.moduleSpecifier.text, node.isTypeOnly, false);
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      if (ts.isExternalModuleReference(ref) && ref.expression && ts.isStringLiteral(ref.expression)) {
        push(ref.expression.text, node.isTypeOnly, true);
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      push(node.arguments[0].text, false, true);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(fileName, source));
  return out;
}

/**
 * Node-only global references, as a bundler would see them: free `process`, `require(...)`, `__dirname`,
 * `__filename`, `import.meta.url`. `globalThis.process` and `typeof process` are deliberately NOT reported —
 * they are how code stays shim-free.
 */
function nodeOnlyGlobals(fileName: string, source: string): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node, guardOnly: boolean): void => {
    if (ts.isTypeOfExpression(node)) {
      ts.forEachChild(node, (child) => visit(child, true));
      return;
    }
    if (ts.isIdentifier(node) && !guardOnly) {
      const parent = node.parent;
      const isMemberName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isPropertySignature(parent) && parent.name === node) ||
        (ts.isMethodDeclaration(parent) && parent.name === node);
      if (!isMemberName && node.text === 'process') out.push('free `process` reference');
      if (node.text === '__dirname' || node.text === '__filename') out.push(node.text);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      out.push('require(...)');
    }
    if (ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression)) {
      out.push('import.meta.url');
    }
    ts.forEachChild(node, (child) => visit(child, guardOnly));
  };
  visit(parse(fileName, source), false);
  return [...new Set(out)];
}

interface Offender {
  what: string;
  via: string[];
}

interface Graph {
  modules: Set<string>;
  offenders: Offender[];
  bareSpecifiers: Set<string>;
}

/** Walk runtime imports from `entry` the way a bundler would. */
function analyse(entry: string): Graph {
  const modules = new Set<string>();
  const offenders: Offender[] = [];
  const bareSpecifiers = new Set<string>();

  const visit = (file: string, via: string[]): void => {
    if (modules.has(file)) return;
    modules.add(file);

    const source = readFileSync(file, 'utf8');
    const chain = [...via, relative(ROOT, file)];

    for (const { specifier, typeOnly, dynamic } of importSpecifiers(file, source)) {
      if (typeOnly) continue; // erased before a bundler sees it
      if (specifier.startsWith('node:')) {
        offenders.push({ what: `${specifier}${dynamic ? ' (dynamic)' : ''}`, via: chain });
      } else if (specifier.startsWith('.')) {
        visit(resolve(dirname(file), specifier).replace(/\.js$/, '.ts'), chain);
      } else {
        bareSpecifiers.add(specifier);
      }
    }
    for (const what of nodeOnlyGlobals(file, source)) offenders.push({ what, via: chain });
  };

  visit(entry, []);
  return { modules, offenders, bareSpecifiers };
}

const graph = analyse(BROWSER_ENTRY);

describe('the walker itself (agent-do-9d2)', () => {
  // If the walker cannot see a form, every assertion below it is weaker than it looks. This table is the
  // contract for "a bundler would follow this", including the side-effect import that the regex version missed.
  it.each([
    ["import x from 'node:fs';", 'node:fs', false],
    ["import { readFile } from 'node:fs';", 'node:fs', false],
    ["import type { X } from 'node:fs';", 'node:fs', true],
    ["import 'node:fs';", 'node:fs', false], // side-effect form: no clause, no `from`
    ["export * from 'node:fs';", 'node:fs', false],
    ["export type { X } from 'node:fs';", 'node:fs', true],
    ["export { x } from './x.js';", './x.js', false],
    ['const m = await import("node:fs");', 'node:fs', false],
    ['import fs = require("node:fs");', 'node:fs', false],
  ])('sees %s', (source, expected, typeOnly) => {
    const found = importSpecifiers('probe.ts', source);
    expect(found.some((s) => s.specifier === expected && s.typeOnly === typeOnly)).toBe(true);
  });

  it('sees a free process reference but not the guarded forms', () => {
    expect(nodeOnlyGlobals('p.ts', 'const a = process.env.HOME;')).toContain('free `process` reference');
    expect(nodeOnlyGlobals('p.ts', 'const p = (globalThis).process; const q = p?.env;')).toEqual([]);
    // The guard EXPRESSION is allowed; a use inside the guarded block is still a free reference, because the
    // AST carries no control flow. That is deliberate and conservative: `globalThis.process` (which usage.ts
    // uses) is the pattern that passes, and a `typeof` guard does not come with a proof that the body is only
    // reachable in Node.
    expect(nodeOnlyGlobals('p.ts', 'if (typeof process !== "undefined") { }')).toEqual([]);
    expect(
      nodeOnlyGlobals('p.ts', 'if (typeof process !== "undefined") { void process; }'),
    ).toContain('free `process` reference');
    expect(nodeOnlyGlobals('p.ts', 'const t = { process?: unknown }; // process.env in prose')).toEqual([]);
    expect(nodeOnlyGlobals('p.ts', 'const u = import.meta.url;')).toContain('import.meta.url');
  });
});

describe('the browser entry graph, walked the way a bundler follows it', () => {
  it('contains no Node builtin, no free process reference, no require/__dirname/import.meta.url', () => {
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
      'src/routines/filesystem.ts',
      'src/scheduled-tasks/fs.ts',
      'src/stores/file-lock.ts',
      'src/stores/sandbox.ts',
      'src/tools/shell-tool.ts',
      'src/tools/workspace-tools.ts',
      'src/agent.ts',
      'src/index.ts',
    ]) {
      expect(
        graph.modules.has(join(ROOT, forbidden)),
        `${forbidden} must NOT be reachable from the browser entry`,
      ).toBe(false);
    }
  });

  it('imports no MCP client transport that pulls Node streams', () => {
    const sdkRoot = join(ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/esm');
    const sdkSpecifiers = [...graph.bareSpecifiers].filter((specifier) =>
      specifier.startsWith('@modelcontextprotocol/sdk/'),
    );
    expect(sdkSpecifiers.length, 'the entry should mount MCP over the SDK').toBeGreaterThan(0);
    for (const specifier of sdkSpecifiers) {
      const file = join(sdkRoot, specifier.slice('@modelcontextprotocol/sdk/'.length));
      expect(existsSync(file), `${specifier} should resolve inside the published SDK`).toBe(true);
      const code = readFileSync(file, 'utf8');
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
    expect('FilesystemRoutineStore' in browserEntry).toBe(false);
  });
});

describe('a runtime that cannot spawn rejects stdio before any dynamic import (agent-do-5sh)', () => {
  const stdioConfig = { name: 'local', transport: { type: 'stdio' as const, command: 'node' } };

  it('rejects via runAgentLoop — the path the review found unguarded', async () => {
    // The guard used to live only in mountRemoteMcpServers, which runAgentLoop never calls, so a stdio config
    // reached the bundler-ignored dynamic import and failed there. It now lives in mountMcpServers, keyed on a
    // capability probe, and defaults to that probe for every caller.
    const versions = process.versions as { node?: string };
    const saved = versions.node;
    try {
      delete versions.node;
      expect(canSpawnStdioMcp()).toBe(false);
      await expect(
        runAgentLoop(
          { mcpServers: [stdioConfig] } as unknown as AgentConfig,
          'say hello',
        ),
      ).rejects.toThrow(/stdio transport[\s\S]*'http' or 'sse'/);
    } finally {
      versions.node = saved;
    }
  });

  it('rejects via mountRemoteMcpServers, which pins the same option', async () => {
    expect('mountMcpServers' in browserEntry).toBe(false);
    await expect(browserEntry.mountRemoteMcpServers([stdioConfig])).rejects.toThrow(
      /stdio transport[\s\S]*'http' or 'sse'/,
    );
  });

  it('reports the capability it actually probed', () => {
    expect(canSpawnStdioMcp()).toBe(true); // this suite runs in Node
  });
});

describe('version metadata', () => {
  it('pins the MCP client version to package.json instead of reading it with node:module', () => {
    const literal = /const LIB_VERSION = '([^']+)'/.exec(readFileSync(join(SRC, 'mcp.ts'), 'utf8'));
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    expect(literal?.[1], 'LIB_VERSION must be a literal in src/mcp.ts').toBeTruthy();
    expect(
      literal?.[1],
      `src/mcp.ts must carry const LIB_VERSION = '${pkg.version}'; (it is a literal so this module needs no ` +
        `node:module; update it in the same commit as the version bump)`,
    ).toBe(pkg.version);
  });
});

describe('the Node entry keeps what it exported before', () => {
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
