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
  readOnly: boolean;
  maxIterations: number;
  noTools: boolean;
  createdAt: string;
}

const AGENTS_DIR = path.join('.agent-do', 'agents');

function agentPath(name: string): string {
  // Sanitize name — alphanumeric, dash, underscore only
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) throw new Error('Agent name must contain alphanumeric characters, dashes, or underscores.');
  return path.join(AGENTS_DIR, `${safe}.json`);
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
  console.log(`  Memory:       ${config.memoryDir}`);
  console.log(`  Max iters:    ${config.maxIterations}`);
  console.log(`  Read-only:    ${config.readOnly}`);
  console.log(`  Tools:        ${config.noTools ? 'disabled' : 'enabled'}`);
  console.log();
  console.log(`Run it: npx agent-do run ${args.agentName} "your task"`);
}

/**
 * List all saved agents.
 */
export async function listSavedAgents(): Promise<void> {
  const exists = await fs.promises.access(AGENTS_DIR).then(() => true).catch(() => false);
  if (!exists) {
    console.log('No saved agents. Create one with: npx agent-do create <name>');
    return;
  }

  const files = await fs.promises.readdir(AGENTS_DIR);
  const jsonFiles = files.filter(f => f.endsWith('.json'));

  if (jsonFiles.length === 0) {
    console.log('No saved agents. Create one with: npx agent-do create <name>');
    return;
  }

  console.log('Saved agents:\n');
  for (const file of jsonFiles.sort()) {
    try {
      const content = await fs.promises.readFile(path.join(AGENTS_DIR, file), 'utf-8');
      const config = JSON.parse(content) as SavedAgent;
      const model = config.model ?? '(default)';
      console.log(`  ${config.name.padEnd(20)} ${config.provider}/${model}  ${config.systemPrompt.slice(0, 40)}${config.systemPrompt.length > 40 ? '...' : ''}`);
    } catch {
      console.log(`  ${file.replace('.json', '').padEnd(20)} (invalid config)`);
    }
  }
  console.log();
}

/**
 * Try to load a saved agent config by name.
 * Returns null if no saved agent with that name exists.
 */
export async function loadSavedAgent(name: string): Promise<SavedAgent | null> {
  const filePath = agentPath(name);
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(content) as SavedAgent;
  } catch {
    return null;
  }
}
