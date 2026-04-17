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
 */

import * as path from 'node:path';
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

export async function runScriptMode(args: ParsedArgs): Promise<void> {
  if (!args.file) {
    throw new Error('Usage: npx agent-do run <file-or-agent-name> [task]');
  }

  // First try loading as a saved agent name
  const saved = await loadSavedAgent(args.file);
  if (saved) {
    return runSavedAgent(saved, args);
  }

  // Otherwise try loading as a file
  const filePath = path.resolve(args.file);
  let mod: Record<string, unknown>;
  try {
    // Use file URL for cross-platform compatibility (Windows paths)
    mod = await import(pathToFileURL(filePath).href);
  } catch (err) {
    throw new Error(
      `No saved agent "${args.file}" found, and failed to import as file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

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
