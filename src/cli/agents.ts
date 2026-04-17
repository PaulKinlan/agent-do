/**
 * Agent management — create, list, and load saved agent configs.
 *
 * Agents are stored as JSON files in .agent-do/agents/<name>.json.
 * They capture provider, model, system prompt, memory dir, and options
 * so you can reference them by name in future runs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { ParsedArgs } from './args.js';

/**
 * Schema for a saved agent JSON file. See issue #22 — earlier
 * versions did `JSON.parse(content) as SavedAgent` with no runtime
 * validation, which let a planted agent file plant a jailbreak
 * system prompt, point `memoryDir` at filesystem root, or drop
 * `__proto__` into the parsed object.
 *
 * Constraints worth highlighting:
 * - `provider` is an explicit enum (no surprise providers).
 * - `memoryDir` is rejected if absolute or if it contains `..` —
 *   prevents memory store escape via crafted config.
 * - `systemPrompt` is capped at 8 KB to bound jailbreak-as-data
 *   payload size.
 * - `.strict()` rejects unknown keys so future footguns fail closed.
 */
export const SavedAgentSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(64),
  // Providers supported by `src/cli/resolve-model.ts`. openrouter was
  // in an earlier draft of this enum but the CLI resolver doesn't
  // handle it (#64 Copilot), so listing it here would have let
  // `create` accept a config that `run` would reject later. If CLI
  // OpenRouter support lands, update both surfaces in the same change.
  provider: z.enum(['anthropic', 'google', 'openai', 'ollama']),
  model: z.string().max(128).optional(),
  systemPrompt: z.string().max(8192),
  memoryDir: z
    .string()
    .max(256)
    .refine((v) => !path.isAbsolute(v), {
      message: 'memoryDir must be a relative path (no absolute paths)',
    })
    .refine((v) => !v.split(/[/\\]/).includes('..'), {
      message: 'memoryDir must not contain `..` segments',
    }),
  withMemory: z.boolean().optional(),
  readOnly: z.boolean(),
  maxIterations: z.number().int().positive().max(1000),
  noTools: z.boolean(),
  createdAt: z.string(),
}).strict();

export type SavedAgent = z.infer<typeof SavedAgentSchema>;

const AGENTS_DIR = path.join('.agent-do', 'agents');

function validateAgentName(name: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(
      `Invalid agent name "${name}". Names may only contain alphanumeric characters, dashes, and underscores.`,
    );
  }
}

/**
 * `JSON.parse` reviver that drops prototype-pollution keys at any
 * depth. Belt-and-braces — even if a future Zod refactor weakens the
 * schema, these keys can never reach the parsed object.
 */
function safeJsonParse(text: string): unknown {
  return JSON.parse(text, (key, value) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return undefined;
    }
    return value;
  });
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

  // Build the candidate config and round-trip through the schema so
  // `create` enforces the same constraints as `load`. Catches things
  // like an oversize system prompt or an unknown provider before we
  // write a file the loader will then reject.
  const candidate = {
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
  const validated = SavedAgentSchema.safeParse(candidate);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid agent config:\n${issues}`);
  }
  const config: SavedAgent = validated.data;

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
 *
 * Walks up the directory tree from cwd — closest ancestor wins (like
 * `.git`). Returns `null` if the file is missing, malformed JSON, or
 * fails the {@link SavedAgentSchema} validation. Validation failures
 * print a diagnostic to stderr so a planted bad file doesn't fail
 * silently — the operator can see why the agent didn't load.
 *
 * See #22 — pre-validation, this function did
 * `JSON.parse(content) as SavedAgent` and accepted any shape, which
 * let a planted agent file plant arbitrary system prompts and point
 * `memoryDir` outside the project root.
 */
export async function loadSavedAgent(name: string): Promise<SavedAgent | null> {
  const filePath = await findAgentFile(name);
  if (!filePath) return null;
  // Read and parse as two separate steps so the failure modes don't
  // blur together (Copilot #64). "Malformed JSON" is an actionable
  // diagnostic; "permission denied" is something the operator needs
  // to fix at the filesystem level.
  let content: string;
  try {
    content = await fs.promises.readFile(filePath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[agent-do] Could not read agent file ${filePath}: ${msg}\n`,
    );
    return null;
  }
  let raw: unknown;
  try {
    raw = safeJsonParse(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[agent-do] Ignoring malformed agent file ${filePath}: ${msg}\n`,
    );
    return null;
  }
  const parsed = SavedAgentSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    process.stderr.write(
      `[agent-do] Ignoring invalid agent file ${filePath}:\n${issues}\n`,
    );
    return null;
  }
  return parsed.data;
}
