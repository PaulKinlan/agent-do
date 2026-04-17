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
import { buildCliPermissions } from './permission-handler.js';
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
/**
 * Hard cap on a script file before we'll hash it for the confirmation
 * banner. Per-PR-#66 Copilot: reading the whole file into memory just
 * to compute a SHA-256 is wasteful for large files; cap at a safe
 * upper bound and stream the hash instead of buffering.
 */
const SCRIPT_MAX_SIZE = 2 * 1024 * 1024; // 2 MB

async function hashFileStreaming(filePath: string): Promise<string> {
  const hasher = createHash('sha256');
  const stream = fs.createReadStream(filePath);
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk) => hasher.update(chunk as Buffer));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hasher.digest('hex').slice(0, 16);
}

async function confirmScriptImport(filePath: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      `[agent-do] --script needs interactive confirmation. Pass -y/--yes to run non-interactively.\n`,
    );
    return false;
  }
  const stat = await fs.promises.stat(filePath);
  if (stat.size > SCRIPT_MAX_SIZE) {
    process.stderr.write(
      `[agent-do] Refusing script import: file is ${stat.size} bytes, limit is ${SCRIPT_MAX_SIZE}. ` +
      `A script this large is almost certainly not an agent definition.\n`,
    );
    return false;
  }
  // Stream the SHA-256 rather than buffering the whole file. Lets the
  // banner appear quickly on a 1 MB script instead of waiting for a
  // full readFile round trip.
  const sha = await hashFileStreaming(filePath);
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
 * True iff `candidate` is the same as, or strictly inside, `base`.
 * Uses `path.relative` so the check handles filesystem roots correctly
 * (Codex #66 P2: `cwd === "/"` made the old `startsWith(cwd + sep)`
 * check compose `"//"` and reject every legit path). A sibling whose
 * name shares the base prefix also returns a relative path starting
 * with `..` and is rejected.
 */
function withinCwd(candidate: string, base: string): boolean {
  if (candidate === base) return true;
  const rel = path.relative(base, candidate);
  if (rel === '' || rel === '.') return true;
  if (rel.startsWith('..')) return false;
  return !path.isAbsolute(rel);
}

/**
 * Resolve, validate, and import a script path. Throws with a specific
 * error on each failure mode so tests can distinguish them.
 *
 * - Canonicalises the target via `fs.realpath` before the cwd-containment
 *   check, so a `./trusted.mjs` that's actually a symlink to
 *   `../outside.mjs` is detected and refused (Codex #66 P2).
 * - `withinCwd` uses `path.relative` rather than a naive `startsWith`
 *   so filesystem-root cwds (`/` on POSIX, `C:\` on Windows) don't
 *   reject every legit child.
 * - Requires the target to be a regular file (`stat().isFile()`).
 *   `access(R_OK)` would also accept a readable directory or special
 *   file, deferring the error to a confusing point inside `import()`.
 */
/**
 * Canonicalise the deepest existing ancestor of `p` and re-append the
 * unresolved suffix. Used for the fast-fail containment check so we
 * compare canonical-to-canonical even when the leaf doesn't exist.
 *
 * Codex follow-up on PR #66: without this, the shell cwd is realpathed
 * (`/private/var/tmp/...` on macOS) while `requested` stays at
 * `/var/tmp/...`, producing spurious "outside working directory"
 * rejections for safe scripts. This mirrors the `realpathSafe` helper
 * in `FilesystemMemoryStore` (#64).
 */
async function realpathSafe(p: string): Promise<string> {
  let suffix = '';
  let current = p;
  // Walk up until realpath succeeds. `access` is cheaper than realpath
  // for a negative check, and its ENOENT behaviour matches ours.
  while (true) {
    try {
      const canonical = await fs.promises.realpath(current);
      return suffix ? path.join(canonical, suffix) : canonical;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) return p; // hit root without resolving
      suffix = path.join(path.basename(current), suffix);
      current = parent;
    }
  }
}

export async function importScriptFile(
  rawPath: string,
  opts: { yes: boolean },
): Promise<Record<string, unknown>> {
  const requested = path.resolve(rawPath);
  // Canonicalise cwd too (macOS /var -> /private/var, etc.) so both
  // sides of the comparison are realpathed — same canonical-vs-canonical
  // invariant as the FilesystemMemoryStore trust-boundary fix (#64).
  const cwd = await fs.promises.realpath(process.cwd());

  // Canonicalise the *ancestors* of `requested` so the fast-fail
  // containment check also compares canonical-to-canonical. Without
  // this the check rejects valid in-tree scripts when the shell cwd
  // is a symlink path (Codex #66 follow-up).
  const canonicalRequested = await realpathSafe(requested);
  if (!withinCwd(canonicalRequested, cwd)) {
    throw new Error(
      `Refusing to import "${requested}": path is outside the working directory (${cwd}).`,
    );
  }

  // Now canonicalise the target fully to detect the symlink-escape
  // case: `./trusted.mjs` points inside cwd string-wise but the
  // symlink target is outside. If the path doesn't exist, realpath
  // throws ENOENT — translate to the friendlier "not found" message.
  let filePath: string;
  try {
    filePath = await fs.promises.realpath(requested);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Script not found: ${requested}`);
    }
    throw err;
  }
  if (!withinCwd(filePath, cwd)) {
    throw new Error(
      `Refusing to import "${filePath}": path is outside the working directory (${cwd}).`,
    );
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    throw new Error(`Script not found or unreadable: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(
      `Refusing to import "${filePath}": not a regular file (is it a directory or special file?).`,
    );
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
    // It's an Agent instance. The script already built its own
    // permissions surface — the CLI can't retrofit `--accept-all` /
    // `--allow` / the prompt handler onto a pre-built agent, so warn
    // the operator that the CLI policy is NOT in force. (Codex #68
    // P1: silently ignoring the flags was worse than not applying
    // them in the first place; now the operator sees the mismatch.)
    if (!args.json && (args.acceptAll || args.allow.length > 0)) {
      process.stderr.write(
        `[agent-do] Note: ${args.file} exports a pre-built Agent instance, so ` +
        `--accept-all and --allow have no effect. Export a config object instead ` +
        `if you want the CLI permission policy to apply.\n`,
      );
    }
    agent = exported as unknown as Agent;
  } else if (exported.model && exported.id) {
    // It's an AgentConfig — create agent from it. Inject CLI
    // permissions unless the config explicitly sets its own. Codex
    // #68 P1: without this, a config-object export silently inherits
    // the old "accept-all" default when the CLI caller expected the
    // new ask policy.
    const cfg = { ...(exported as Record<string, unknown>) };
    if (cfg.permissions === undefined) {
      cfg.permissions = buildCliPermissions({
        acceptAll: args.acceptAll,
        allow: args.allow,
      });
    }
    agent = createAgent(cfg as any);
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
      permissions: buildCliPermissions({ acceptAll: args.acceptAll, allow: args.allow }),
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
    permissions: buildCliPermissions({ acceptAll: args.acceptAll, allow: args.allow }),
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
