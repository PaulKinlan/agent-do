/**
 * Agent management — create, list, and load saved agent configs.
 *
 * Agents are stored as JSON files in .agent-do/agents/<name>.json.
 * They capture provider, model, system prompt, memory dir, and options
 * so you can reference them by name in future runs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ParsedArgs } from './args.js';

export interface SavedAgent {
  name: string;
  provider: string;
  model?: string;
  systemPrompt: string;
  memoryDir: string;
  /**
   * Enable the agent's private memory tools (memory_read, memory_write, etc.).
   * Workspace tools (read_file, write_file) are always enabled unless noTools.
   */
  withMemory?: boolean;
  readOnly: boolean;
  maxIterations: number;
  noTools: boolean;
  createdAt: string;
}

const AGENTS_DIR = path.join('.agent-do', 'agents');

function validateAgentName(name: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(
      `Invalid agent name "${name}". Names may only contain alphanumeric characters, dashes, and underscores.`,
    );
  }
}

function agentPath(name: string): string {
  validateAgentName(name);
  return path.join(AGENTS_DIR, `${name}.json`);
}

/**
 * Walk up from `startDir` to filesystem root, yielding each ancestor.
 * Stops when it can't go any higher (path.dirname returns the same value).
 */
function* walkUp(startDir: string): Generator<string> {
  let dir = path.resolve(startDir);
  while (true) {
    yield dir;
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/**
 * Find a saved agent file by name, walking up the directory tree.
 * Returns the closest match (nearest ancestor wins), or null.
 */
async function findAgentFile(name: string): Promise<string | null> {
  validateAgentName(name);
  for (const dir of walkUp(process.cwd())) {
    const candidate = path.join(dir, AGENTS_DIR, `${name}.json`);
    const exists = await fs.promises.access(candidate).then(() => true).catch(() => false);
    if (exists) return candidate;
  }
  return null;
}

/**
 * Create and save a new agent config.
 */
export async function createSavedAgent(args: ParsedArgs): Promise<void> {
  if (!args.agentName) {
    throw new Error('Usage: npx agent-do create <name> [options]');
  }

  const config: SavedAgent = {
    name: args.agentName,
    provider: args.provider,
    model: args.model,
    systemPrompt: args.systemPrompt,
    memoryDir: args.memoryDir,
    withMemory: args.withMemory,
    readOnly: args.readOnly,
    maxIterations: args.maxIterations,
    noTools: args.noTools,
    createdAt: new Date().toISOString(),
  };

  await fs.promises.mkdir(AGENTS_DIR, { recursive: true });
  const filePath = agentPath(args.agentName);

  const exists = await fs.promises.access(filePath).then(() => true).catch(() => false);
  if (exists) {
    // Overwrite — user can update config by re-creating
    console.log(`Updating agent "${args.agentName}"...`);
  }

  await fs.promises.writeFile(filePath, JSON.stringify(config, null, 2) + '\n');
  console.log(`Agent "${args.agentName}" saved to ${filePath}`);
  console.log();
  console.log(`  Provider:     ${config.provider}`);
  console.log(`  Model:        ${config.model ?? '(provider default)'}`);
  console.log(`  System:       ${config.systemPrompt.slice(0, 60)}${config.systemPrompt.length > 60 ? '...' : ''}`);
  console.log(`  Memory:       ${config.memoryDir}${config.withMemory ? '' : ' (disabled — pass --with-memory to enable)'}`);
  console.log(`  Max iters:    ${config.maxIterations}`);
  console.log(`  Read-only:    ${config.readOnly}`);
  console.log(`  Tools:        ${config.noTools ? 'disabled' : 'workspace (cwd)'}`);
  console.log();
  console.log(`Run it: npx agent-do run ${args.agentName} "your task"`);
}

/**
 * List all saved agents visible from the current directory, walking up
 * the tree. If the same name appears at multiple levels, the closest
 * ancestor wins (matching the lookup behavior of `loadSavedAgent`).
 */
export async function listSavedAgents(): Promise<void> {
  const seen = new Map<string, { config: SavedAgent; file: string; location: string }>();

  for (const dir of walkUp(process.cwd())) {
    const agentsDir = path.join(dir, AGENTS_DIR);
    const dirExists = await fs.promises.access(agentsDir).then(() => true).catch(() => false);
    if (!dirExists) continue;

    const files = await fs.promises.readdir(agentsDir);
    for (const file of files.filter(f => f.endsWith('.json'))) {
      const name = file.replace(/\.json$/, '');
      if (seen.has(name)) continue; // closer ancestor already claimed this name
      try {
        const content = await fs.promises.readFile(path.join(agentsDir, file), 'utf-8');
        const config = JSON.parse(content) as SavedAgent;
        seen.set(name, { config, file, location: dir });
      } catch {
        seen.set(name, { config: { name } as SavedAgent, file, location: dir });
      }
    }
  }

  if (seen.size === 0) {
    console.log('No saved agents. Create one with: npx agent-do create <name>');
    return;
  }

  console.log('Saved agents:\n');
  const cwd = process.cwd();
  for (const name of [...seen.keys()].sort()) {
    const { config, location } = seen.get(name)!;
    const rel = path.relative(cwd, location) || '.';
    const model = config.model ?? '(default)';
    if (!config.provider) {
      console.log(`  ${name.padEnd(20)} (invalid config)  [${rel}]`);
      continue;
    }
    const prompt = config.systemPrompt ?? '';
    console.log(
      `  ${config.name.padEnd(20)} ${config.provider}/${model}  ${prompt.slice(0, 40)}${prompt.length > 40 ? '...' : ''}  [${rel}]`,
    );
  }
  console.log();
}

/**
 * Try to load a saved agent config by name.
 * Walks up the directory tree from cwd — closest ancestor wins (like `.git`).
 * Returns null if no saved agent with that name exists.
 */
export async function loadSavedAgent(name: string): Promise<SavedAgent | null> {
  const filePath = await findAgentFile(name);
  if (!filePath) return null;
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(content) as SavedAgent;
  } catch {
    return null;
  }
}
