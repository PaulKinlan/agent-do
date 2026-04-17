/**
 * Script mode — run a JS/TS file that exports an agent.
 *
 * Usage: npx agent-do run my-agent.ts [task]
 *
 * The file can export:
 * - An Agent instance (has .run() and .stream())
 * - An AgentConfig object (has .model and .id)
 * - A simple config object (has .systemPrompt, auto-resolves model)
 *
 * Note: .ts files require a TypeScript loader (tsx, ts-node).
 * Run with: npx tsx node_modules/.bin/agent-do run script.ts
 * Or use compiled .js files directly.
 *
 * ## Security (#19, C-03)
 *
 * Importing an arbitrary JS/TS file runs its top-level code with the
 * Node.js process's full privileges. Previously the dispatcher silently
 * fell back from saved-agent lookup to `await import()` on any positional
 * — a social-engineering vector ("run this helper script") and a
 * saved-agent name collision risk. The current behaviour:
 *
 * 1. Positionals that look like a saved-agent name (identifier-shaped,
 *    no slashes, no JS extension) resolve ONLY via saved agents. If the
 *    lookup misses, fail closed with a clear error — never attempt to
 *    import.
 * 2. Positionals that look like a path (start with `./`, `../`, `/`, or
 *    end in `.js`/`.mjs`/`.cjs`/`.ts`/`.mts`/`.cts`) require the explicit
 *    `--script` flag, must be inside cwd, and prompt the user for
 *    confirmation (skip with `-y`/`--yes`, refuse in non-TTY without `-y`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { ParsedArgs } from './args.js';
import { readStdin } from './args.js';
import { resolveModel } from './resolve-model.js';
import { loadSavedAgent } from './agents.js';
import { renderEvent, renderOptionsFromArgs } from './render.js';
import { emitSandboxWarning } from './warnings.js';
import { createAgent } from '../agent.js';
import { createWorkspaceTools } from '../tools/workspace-tools.js';
import { createMemoryTools } from '../tools/memory-tools.js';
import { FilesystemMemoryStore } from '../stores/filesystem.js';
import type { Agent } from '../types.js';
import type { ToolSet } from 'ai';

/**
 * Extensions that identify a positional as a script path rather than a
 * saved-agent name. Kept narrow on purpose — anything not in this list
 * falls through to the saved-agent branch, which errors cleanly if the
 * name is unknown.
 */
const SCRIPT_EXTENSIONS = /\.(?:m?js|cjs|mts|cts|ts)$/i;

/**
 * `true` when the positional unambiguously refers to a filesystem path.
 *
 * The rule is conservative: explicit path prefixes (`./`, `../`, `/`,
 * Windows drive letters) OR a JS/TS extension. This lets saved-agent
 * names stay as short identifiers like `security-reviewer` and avoids
 * the old footgun where a positional with an unknown name silently fell
 * through to `await import()`.
 */
function looksLikeScriptPath(arg: string): boolean {
  if (arg.startsWith('./') || arg.startsWith('../') || arg.startsWith('/')) {
    return true;
  }
  // Windows absolute path: `C:\...` or `C:/...`.
  if (/^[a-zA-Z]:[\\/]/.test(arg)) return true;
  return SCRIPT_EXTENSIONS.test(arg);
}

/**
 * Prompt the user to confirm a script import. Returns `true` on `y`/`yes`
 * (case-insensitive). Refuses to run in non-TTY mode — the caller already
 * checks for `--yes` in that case, so reaching here without a TTY means
 * the user passed `--script` but not `--yes` over a pipe.
 */
async function confirmScriptImport(filePath: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      `[agent-do] --script needs interactive confirmation. Pass -y/--yes to run non-interactively.\n`,
    );
    return false;
  }
  const stat = await fs.promises.stat(filePath);
  const content = await fs.promises.readFile(filePath);
  const sha = createHash('sha256').update(content).digest('hex').slice(0, 16);
  process.stderr.write(
    `[agent-do] About to import and execute a local script:\n` +
    `           path:   ${filePath}\n` +
    `           size:   ${stat.size} bytes\n` +
    `           sha256: ${sha}…\n` +
    `           This will run arbitrary JavaScript with your user privileges.\n`,
  );
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer: string = await new Promise((resolve) => {
      rl.question('[agent-do] Continue? [y/N] ', resolve);
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * Resolve, validate, and import a script path. Throws with a specific
 * error on each failure mode so tests can distinguish them.
 *
 * The containment check compares `resolvedPath` against
 * `cwd + path.sep` (not bare `startsWith`) so a sibling whose name shares
 * the cwd prefix (`/work/project` vs `/work/project-evil`) can't slip
 * through. Same logic as `FilesystemMemoryStore.withinBase` (#20).
 */
export async function importScriptFile(
  rawPath: string,
  opts: { yes: boolean },
): Promise<Record<string, unknown>> {
  const filePath = path.resolve(rawPath);
  const cwd = path.resolve(process.cwd());
  if (filePath !== cwd && !filePath.startsWith(cwd + path.sep)) {
    throw new Error(
      `Refusing to import "${filePath}": path is outside the working directory (${cwd}).`,
    );
  }
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch {
    throw new Error(`Script not found or unreadable: ${filePath}`);
  }
  if (!SCRIPT_EXTENSIONS.test(filePath)) {
    throw new Error(
      `Refusing to import "${filePath}": only .js/.mjs/.cjs/.ts/.mts/.cts files are allowed.`,
    );
  }
  if (!opts.yes) {
    const ok = await confirmScriptImport(filePath);
    if (!ok) throw new Error('Aborted by user.');
  }
  return (await import(pathToFileURL(filePath).href)) as Record<string, unknown>;
}

export async function runScriptMode(args: ParsedArgs): Promise<void> {
  if (!args.file) {
    throw new Error('Usage: npx agent-do run <file-or-agent-name> [task]');
  }

  // Disambiguate path-vs-name *first*. Previously we tried saved-agent
  // lookup, and on miss silently fell back to `import()` — letting a
  // stray `.js` file in cwd masquerade as a saved agent and run before
  // any permission check. Split explicit, fail closed.
  if (!looksLikeScriptPath(args.file)) {
    const saved = await loadSavedAgent(args.file);
    if (saved) return runSavedAgent(saved, args);
    throw new Error(
      `No saved agent "${args.file}" found. If you meant to run a script file, ` +
      `use a path (e.g. ./agent.ts) and pass --script.`,
    );
  }

  if (!args.script) {
    throw new Error(
      `Refusing to import "${args.file}": running a local JS/TS file with agent-do ` +
      `requires --script (it executes arbitrary code with your privileges). ` +
      `Re-run with --script (adds an interactive confirmation) or --script -y to skip it.`,
    );
  }

  const mod = await importScriptFile(args.file, { yes: args.yes });

  const exported = (mod.default ?? mod) as Record<string, unknown>;

  // Determine if it's an Agent instance, AgentConfig, or simple config
  let agent: Agent;

  if (typeof exported.run === 'function' && typeof exported.stream === 'function') {
    // It's an Agent instance
    agent = exported as unknown as Agent;
  } else if (exported.model && exported.id) {
    // It's an AgentConfig — create agent from it
    agent = createAgent(exported as any);
  } else if (exported.systemPrompt || exported.name) {
    // Simple config — resolve model from provider/args
    const model = await resolveModel(
      (exported.provider as string) ?? args.provider,
      (exported.model as string) ?? args.model,
    );
    const agentId = (exported.id as string) ?? 'script-agent';

    // Resolve the *effective* tool flags from the export → args
    // fallback chain. Use those for both the wiring and the sandbox
    // warning, so a script that overrides `noTools: false` doesn't
    // get its file access silently waved through without a warning.
    const effectiveNoTools =
      (exported.noTools as boolean | undefined) ?? args.noTools;
    const effectiveReadOnly =
      (exported.readOnly as boolean | undefined) ?? args.readOnly;
    emitSandboxWarning({
      toolsEnabled: !effectiveNoTools,
      readOnly: effectiveReadOnly,
      json: args.json,
    });

    // Workspace tools on the cwd by default; memory tools opt-in.
    let tools: ToolSet | undefined;
    if (!effectiveNoTools) {
      tools = createWorkspaceTools(args.workingDir, {
        readOnly: effectiveReadOnly,
        exclude: args.exclude,
        includeSensitive: args.includeSensitive,
      });
      const wantMemory =
        (exported.withMemory as boolean | undefined) ?? args.withMemory;
      if (wantMemory) {
        const memDir = (exported.memory as string) ?? args.memoryDir;
        const memStore = new FilesystemMemoryStore(memDir, {
          readOnly: effectiveReadOnly,
        });
        tools = { ...tools, ...createMemoryTools(memStore, agentId) };
      }
    }

    agent = createAgent({
      id: agentId,
      name: (exported.name as string) ?? 'Script Agent',
      model,
      systemPrompt: (exported.systemPrompt as string) ?? args.systemPrompt,
      tools,
      maxIterations: (exported.maxIterations as number) ?? args.maxIterations,
      permissions: { mode: 'accept-all' },
      usage: { enabled: true },
      emitFullResult: args.showContent,
    });
  } else {
    throw new Error(
      'Script must export an Agent instance, an AgentConfig (with model + id), ' +
      'or a simple config (with systemPrompt or name).',
    );
  }

  // Get the task
  const stdinContent = await readStdin();
  const task = buildTask(args.prompt, stdinContent);

  if (!task) {
    throw new Error(
      'No task provided. Pass a prompt after the file: npx agent-do run script.ts "your task"',
    );
  }

  // Run the agent — quiet by default, only final answer printed
  const renderOpts = renderOptionsFromArgs(args);
  let sawError = false;
  for await (const event of agent.stream(task)) {
    const { handled } = renderEvent(event, renderOpts);
    if (handled) continue;
    if (event.type === 'done') {
      if (!args.verbose) process.stdout.write(event.content);
      process.stdout.write('\n');
    }
    if (event.type === 'error') sawError = true;
  }
  if (sawError) process.exit(1);
}

async function runSavedAgent(
  saved: import('./agents.js').SavedAgent,
  args: ParsedArgs,
): Promise<void> {
  const model = await resolveModel(saved.provider, saved.model);
  const agentId = saved.name;

  // Resolve effective flags BEFORE the warning, otherwise (per Codex's
  // P2 on PR #47) `npx agent-do run <saved> --no-tools` would suppress
  // the warning while a saved agent with `noTools: false` still ran
  // with full file access. Saved-agent config wins because that's
  // what actually drives `tools` below.
  const effectiveNoTools = saved.noTools;
  const effectiveReadOnly = saved.readOnly || args.readOnly;
  emitSandboxWarning({
    toolsEnabled: !effectiveNoTools,
    readOnly: effectiveReadOnly,
    json: args.json,
  });

  let tools: ToolSet | undefined;
  if (!effectiveNoTools) {
    // Workspace tools default to the caller's cwd so saved agents see the
    // project they were invoked against, not the dir where they were created.
    tools = createWorkspaceTools(args.workingDir, {
      readOnly: effectiveReadOnly,
      exclude: args.exclude,
      includeSensitive: args.includeSensitive,
    });
    if (saved.withMemory || args.withMemory) {
      const memStore = new FilesystemMemoryStore(saved.memoryDir, {
        readOnly: saved.readOnly,
      });
      tools = { ...tools, ...createMemoryTools(memStore, agentId) };
    }
  }

  const agent = createAgent({
    id: agentId,
    name: saved.name,
    model,
    systemPrompt: saved.systemPrompt,
    tools,
    maxIterations: saved.maxIterations,
    permissions: { mode: 'accept-all' },
    usage: { enabled: true },
    emitFullResult: args.showContent,
  });

  const stdinContent = await readStdin();
  const task = buildTask(args.prompt, stdinContent);

  if (!task) {
    throw new Error(
      `No task provided. Run: npx agent-do run ${saved.name} "your task"`,
    );
  }

  const renderOpts = renderOptionsFromArgs(args);
  let sawError = false;
  for await (const event of agent.stream(task)) {
    const { handled } = renderEvent(event, renderOpts);
    if (handled) continue;
    if (event.type === 'done') {
      if (!args.verbose) process.stdout.write(event.content);
      process.stdout.write('\n');
    }
    if (event.type === 'error') sawError = true;
  }
  if (sawError) process.exit(1);
}

function buildTask(prompt?: string, stdin?: string): string | null {
  if (prompt && stdin) return `${prompt}\n\n---\n\n${stdin}`;
  if (prompt) return prompt;
  if (stdin) return stdin;
  return null;
}
