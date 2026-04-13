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
import { createAgent } from '../agent.js';
import { createFileTools } from '../tools/file-tools.js';
import { FilesystemMemoryStore } from '../stores/filesystem.js';
import type { Agent } from '../types.js';

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

    // Respect --no-tools flag
    let tools = undefined;
    if (!args.noTools) {
      const memDir = (exported.memory as string) ?? args.memoryDir;
      const store = new FilesystemMemoryStore(memDir, { readOnly: args.readOnly });
      tools = createFileTools(store, agentId);
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
  for await (const event of agent.stream(task)) {
    switch (event.type) {
      case 'thinking':
        if (args.verbose) {
          process.stdout.write(event.content);
        }
        break;
      case 'tool-call':
        if (args.verbose) {
          console.log(`\n[tool] ${event.toolName}(${JSON.stringify(event.toolArgs).slice(0, 100)})`);
        }
        break;
      case 'tool-result':
        if (args.verbose) {
          console.log(`[result] ${String(event.toolResult).slice(0, 200)}`);
        }
        break;
      case 'text':
        if (args.verbose) {
          console.log(event.content);
        }
        break;
      case 'done':
        if (!args.verbose) {
          process.stdout.write(event.content);
        }
        process.stdout.write('\n');
        break;
      case 'error':
        console.error(`Error: ${event.content}`);
        process.exit(1);
        break;
    }
  }
}

async function runSavedAgent(
  saved: import('./agents.js').SavedAgent,
  args: ParsedArgs,
): Promise<void> {
  const model = await resolveModel(saved.provider, saved.model);
  const agentId = saved.name;

  let tools = undefined;
  if (!saved.noTools) {
    const store = new FilesystemMemoryStore(saved.memoryDir, { readOnly: saved.readOnly });
    tools = createFileTools(store, agentId);
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
  });

  const stdinContent = await readStdin();
  const task = buildTask(args.prompt, stdinContent);

  if (!task) {
    throw new Error(
      `No task provided. Run: npx agent-do run ${saved.name} "your task"`,
    );
  }

  for await (const event of agent.stream(task)) {
    switch (event.type) {
      case 'thinking':
        if (args.verbose) process.stdout.write(event.content);
        break;
      case 'tool-call':
        if (args.verbose) console.log(`\n[tool] ${event.toolName}(${JSON.stringify(event.toolArgs).slice(0, 100)})`);
        break;
      case 'tool-result':
        if (args.verbose) console.log(`[result] ${String(event.toolResult).slice(0, 200)}`);
        break;
      case 'text':
        if (args.verbose) console.log(event.content);
        break;
      case 'done':
        if (!args.verbose) process.stdout.write(event.content);
        process.stdout.write('\n');
        break;
      case 'error':
        console.error(`Error: ${event.content}`);
        process.exit(1);
        break;
    }
  }
}

function buildTask(prompt?: string, stdin?: string): string | null {
  if (prompt && stdin) return `${prompt}\n\n---\n\n${stdin}`;
  if (prompt) return prompt;
  if (stdin) return stdin;
  return null;
}
