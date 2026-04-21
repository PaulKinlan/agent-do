/**
 * createTemplatePack() — compose a ready-to-run agent from a pack (#78).
 *
 * The pack loader (see `loader.ts`) gives us manifest + parsed skills,
 * routines, and raw policy bodies. This module turns that into an
 * Agent by:
 *
 *   1. Interpolating `{{var}}` placeholders in systemPrompt, policies,
 *      and skill/routine bodies with the caller-supplied variables.
 *   2. Installing skills into an in-memory skill store so the agent
 *      can list/load them at runtime.
 *   3. Installing routines into an in-memory routine store.
 *   4. Validating that every `manifest.mcpServers` entry is matched in
 *      `options.mcpServers`.
 *   5. Composing the system prompt: manifest.systemPrompt + all
 *      policy bodies, concatenated with headers.
 *   6. Wiring workspace / memory tools if the manifest asked for them.
 *
 * The returned {@link TemplatePack} exposes the agent plus the
 * composed artefacts (system prompt, skills, routines) so callers can
 * inspect what the pack baked in — useful for debugging and for
 * building richer UIs around installed packs.
 */

import { createAgent } from '../agent.js';
import { interpolate } from '../prompts/builder.js';
import { InMemorySkillStore } from '../skills.js';
import { InMemoryRoutineStore } from '../routines.js';
import { createWorkspaceTools } from '../tools/workspace-tools.js';
import { createMemoryTools } from '../tools/memory-tools.js';
import { InMemoryMemoryStore } from '../stores/in-memory.js';
import { loadPack } from './loader.js';
import type {
  CreateTemplatePackOptions,
  LoadedPack,
  TemplatePack,
} from './types.js';
import type { Skill, Routine } from '../types.js';
import type { ToolSet } from 'ai';

/**
 * Apply `{{name}}` substitution to a string with the provided vars.
 * Thin wrapper over `interpolate` so this module has a single call
 * site — keeps the substitution semantics consistent across the
 * systemPrompt / policies / skills / routines surfaces.
 */
function apply(value: string, vars: Record<string, string> | undefined): string {
  if (!vars || Object.keys(vars).length === 0) return value;
  return interpolate(value, vars);
}

function resolveVariables(
  loaded: LoadedPack,
  provided: Record<string, string> | undefined,
): Record<string, string> {
  const vars: Record<string, string> = Object.create(null);
  // Seed defaults from the manifest.
  for (const decl of loaded.manifest.variables ?? []) {
    if (decl.default !== undefined) vars[decl.name] = decl.default;
  }
  // Caller overrides defaults.
  if (provided) {
    for (const [k, v] of Object.entries(provided)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      vars[k] = v;
    }
  }
  // Enforce required variables.
  const missing: string[] = [];
  for (const decl of loaded.manifest.variables ?? []) {
    if (decl.required && (vars[decl.name] === undefined || vars[decl.name] === '')) {
      missing.push(decl.name);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Pack "${loaded.manifest.name}" requires variables: ${missing.join(', ')}. ` +
      `Pass them via \`variables\` on createTemplatePack().`,
    );
  }
  return vars;
}

function validateMcpServers(
  loaded: LoadedPack,
  provided: CreateTemplatePackOptions['mcpServers'],
): void {
  const required = loaded.manifest.mcpServers ?? [];
  if (required.length === 0) return;
  const providedKeys = new Set(Object.keys(provided ?? {}));
  const missing = required.filter((name) => !providedKeys.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Pack "${loaded.manifest.name}" requires MCP servers: ${missing.join(', ')}. ` +
      `Pass them via \`mcpServers\` on createTemplatePack() ` +
      `(keys must match the manifest names).`,
    );
  }
}

/**
 * Convert the pack name to a human-readable default agent name
 * (`chief-of-staff` → `Chief Of Staff`). Callers can override via
 * `options.name`.
 */
function humanName(packName: string): string {
  return packName
    .split(/[-_]/)
    .map((part) => (part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(' ');
}

function composeSystemPrompt(
  loaded: LoadedPack,
  vars: Record<string, string>,
): string {
  const parts: string[] = [];
  if (loaded.manifest.systemPrompt) {
    parts.push(apply(loaded.manifest.systemPrompt, vars).trim());
  }
  for (const policy of loaded.policies) {
    const body = apply(policy.body, vars).trim();
    if (!body) continue;
    parts.push(`## Policy: ${policy.name}\n\n${body}`);
  }
  return parts.join('\n\n').trim();
}

function interpolateSkills(skills: Skill[], vars: Record<string, string>): Skill[] {
  return skills.map((skill) => ({
    ...skill,
    description: apply(skill.description, vars),
    content: apply(skill.content, vars),
  }));
}

function interpolateRoutines(routines: Routine[], vars: Record<string, string>): Routine[] {
  return routines.map((routine) => ({
    ...routine,
    description: apply(routine.description, vars),
    body: apply(routine.body, vars),
  }));
}

/**
 * Create a ready-to-run agent from a template pack.
 *
 * @example
 * ```ts
 * import { createTemplatePack } from 'agent-do';
 * import { createAnthropic } from '@ai-sdk/anthropic';
 *
 * const { agent } = await createTemplatePack('chief-of-staff', {
 *   model: createAnthropic()('claude-sonnet-4-6'),
 *   variables: { owner: 'Paul Kinlan' },
 *   // mcpServers: { gmail: {...}, calendar: {...} },  // when the pack declares them
 * });
 *
 * const answer = await agent.run('Triage the inbox');
 * ```
 */
export async function createTemplatePack(
  name: string,
  options: CreateTemplatePackOptions,
): Promise<TemplatePack> {
  if (!options || !options.model) {
    throw new Error(
      'createTemplatePack requires `options.model`. agent-do is provider-agnostic; ' +
      'pass any Vercel AI SDK LanguageModel.',
    );
  }
  const loaded = await loadPack(name, {
    packsDir: options.packsDir,
  });
  const vars = resolveVariables(loaded, options.variables);
  validateMcpServers(loaded, options.mcpServers);

  const skills = interpolateSkills(loaded.skills, vars);
  const routines = interpolateRoutines(loaded.routines, vars);

  // Install skills into an in-memory store so the agent loop can list
  // / load them.
  const skillStore = new InMemorySkillStore();
  for (const skill of skills) await skillStore.install(skill);

  const routineStore = new InMemoryRoutineStore();
  for (const routine of routines) await routineStore.save(routine);

  // Compose tools from the pack's declared groups plus caller overrides.
  let tools: ToolSet = {};
  const toolGroups = loaded.manifest.tools ?? [];
  for (const group of toolGroups) {
    if (group === 'workspace') {
      const workspaceTools = createWorkspaceTools(
        options.workingDir ?? process.cwd(),
      );
      tools = { ...tools, ...workspaceTools };
    } else if (group === 'memory') {
      const memStore = new InMemoryMemoryStore();
      const memoryTools = createMemoryTools(memStore, options.id ?? loaded.manifest.name);
      tools = { ...tools, ...memoryTools };
    }
  }
  if (options.tools) tools = { ...tools, ...options.tools };

  // Compose the MCP server list. The manifest only *names* required
  // servers; the caller provides the configs. If the caller passes
  // extra servers not declared in the manifest we forward them — a
  // pack saying "I need gmail" doesn't prevent a user from also wiring
  // a workspace-wide tool server.
  const mcpServers = options.mcpServers
    ? Object.entries(options.mcpServers).map(([serverName, cfg]) => ({
        ...cfg,
        name: cfg.name ?? serverName,
      }))
    : undefined;

  const systemPrompt = composeSystemPrompt(loaded, vars);

  const agent = createAgent({
    id: options.id ?? loaded.manifest.name,
    name: options.name ?? humanName(loaded.manifest.name),
    model: options.model,
    systemPrompt,
    tools: Object.keys(tools).length > 0 ? tools : undefined,
    skills: skillStore,
    routines: routineStore,
    mcpServers,
    hooks: options.hooks,
    permissions: options.permissions,
    maxIterations: options.maxIterations,
    ...(options.agentConfigOverrides ?? {}),
  });

  return {
    agent,
    manifest: loaded.manifest,
    skills,
    routines,
    systemPrompt,
  };
}
