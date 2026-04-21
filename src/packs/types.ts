/**
 * Template Pack types (#78).
 *
 * A "pack" is an opinionated composition of skills, routines, policies,
 * tools, and MCP server bindings that users can install with one
 * command. See {@link PackManifest} for the on-disk shape and
 * {@link CreateTemplatePackOptions} for the runtime surface consumed by
 * `createTemplatePack`.
 */

import type { LanguageModel, ToolSet } from 'ai';
import type { McpServerConfig } from '../mcp.js';
import type { Agent, AgentConfig, AgentHooks, PermissionConfig } from '../types.js';
import type { Skill, Routine } from '../types.js';

/**
 * The `pack.json` manifest shape. Every pack ships one.
 *
 * Field semantics:
 *
 *  - `name` — canonical pack id. Kebab-case; used as the directory name
 *    under `.agent-do/packs/<name>/` when installed and as the argument
 *    to `createTemplatePack(name, ...)`.
 *  - `version` — pack version. Recorded in `.agent-do/config.json` on
 *    install so pack upgrades are detectable.
 *  - `description` — one-line summary shown by `list-packs`.
 *  - `roles` — optional list of role names the pack composes. Purely
 *    informational today; packs that need multi-agent orchestration
 *    wire it up themselves in their `systemPrompt`.
 *  - `skills` — relative paths (or basename-without-extension) of
 *    SKILL.md files shipped under `skills/` inside the pack dir. The
 *    loader resolves them; callers never list files directly.
 *  - `routines` — relative paths (or basename-without-extension) of
 *    routine markdown files shipped under `routines/`. Same loading
 *    rules as skills.
 *  - `policies` — relative paths (or basename-without-extension) of
 *    markdown files shipped under `policies/`. Policy files are
 *    concatenated verbatim into the agent's system prompt (after the
 *    pack's own `systemPrompt`) — they're opinionated guidance the
 *    pack author wants the model to always see.
 *  - `mcpServers` — names of MCP servers the pack *expects* the caller
 *    to provide at `createTemplatePack` time. Every entry listed here
 *    must be matched by a key in `options.mcpServers`; missing ones
 *    fail the create call with a readable error. agent-do deliberately
 *    does not ship MCP server wiring in packs — servers have
 *    credentials, spawn commands, and trust boundaries that are
 *    host-specific.
 *  - `tools` — advisory list of built-in tool groups the pack expects
 *    (`workspace`, `memory`). The loader enables them; unknown entries
 *    are ignored with a warning.
 *  - `heartbeat` — optional path (relative to the pack dir) of a
 *    schedule file. Advisory only — agent-do does not ship a cron
 *    runner; callers that want scheduling wire it up with their own
 *    infrastructure. Surfaced for parity with the issue spec so pack
 *    authors can declare their intent.
 *  - `systemPrompt` — the base system prompt for the pack's agent.
 *    Policy files are appended after this.
 *  - `variables` — declared variables the pack accepts (e.g. `owner`,
 *    `timezone`). Used by `createTemplatePack` to populate defaults
 *    and (in future) produce user-facing prompts for values the
 *    caller didn't supply.
 */
export interface PackManifest {
  name: string;
  version: string;
  description: string;
  roles?: string[];
  skills?: string[];
  routines?: string[];
  policies?: string[];
  mcpServers?: string[];
  tools?: Array<'workspace' | 'memory'>;
  heartbeat?: string;
  systemPrompt?: string;
  variables?: Array<PackVariable>;
}

/**
 * Declared variable in a pack manifest. A pack that references
 * `{{owner}}` in its systemPrompt / policies / skill bodies declares
 * the variable here so `createTemplatePack` can validate that the
 * caller supplied it.
 */
export interface PackVariable {
  name: string;
  description?: string;
  default?: string;
  /** When true, `createTemplatePack` throws if the caller omits this variable. */
  required?: boolean;
}

/**
 * The loaded shape of a pack — manifest + the parsed content of its
 * skills / routines / policies. Produced by `loadPack()`.
 */
export interface LoadedPack {
  manifest: PackManifest;
  /** Absolute directory the pack was loaded from. */
  dir: string;
  skills: Skill[];
  routines: Routine[];
  /** Policy files, in manifest order. Each entry is the raw markdown body. */
  policies: Array<{ name: string; body: string }>;
}

/**
 * Config passed to {@link createTemplatePack}.
 *
 * agent-do is provider-agnostic; the caller always supplies the model.
 * MCP servers are also caller-supplied (they have credentials and
 * trust boundaries). Variables declared by the pack are passed as a
 * flat map — if the caller uses top-level keys that don't collide with
 * reserved fields they're forwarded into `variables` as a convenience.
 */
export interface CreateTemplatePackOptions {
  /** LanguageModel to run the pack's agent. Required. */
  model: LanguageModel;
  /**
   * Variables declared in the pack manifest. Interpolated into the
   * system prompt, policies, and skill/routine bodies via the same
   * `{{name}}` substitution rule as the rest of agent-do.
   */
  variables?: Record<string, string>;
  /**
   * MCP servers keyed by the same names the pack manifest declares.
   * Every name listed in `manifest.mcpServers` must have a match here.
   */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Working directory for workspace tools if the pack declares
   * `tools: ['workspace']`. Default: `process.cwd()`.
   */
  workingDir?: string;
  /**
   * Custom tools merged into the pack's toolset after pack-declared
   * tool groups are resolved. Takes precedence on name collisions so
   * callers can override pack defaults.
   */
  tools?: ToolSet;
  /**
   * Directory to resolve the pack from. Defaults to the bundled
   * packs directory inside the installed `agent-do` package. Pass an
   * explicit path to load from `.agent-do/packs/` (the CLI's install
   * target) or to point tests at fixtures.
   */
  packsDir?: string;
  /**
   * Override the agent id. Defaults to the pack name.
   */
  id?: string;
  /**
   * Override the agent display name. Defaults to a title-cased version
   * of the pack name.
   */
  name?: string;
  /** Lifecycle hooks forwarded to the agent config. */
  hooks?: AgentHooks;
  /** Permission config forwarded to the agent config. */
  permissions?: PermissionConfig;
  /** Max iterations forwarded to the agent config. */
  maxIterations?: number;
  /**
   * Additional AgentConfig fields forwarded verbatim. Use sparingly —
   * the pack composition decides most behaviour; this is an escape
   * hatch for fields we don't explicitly surface above.
   */
  agentConfigOverrides?: Partial<AgentConfig>;
}

/**
 * Result of {@link createTemplatePack}: the ready-to-run agent plus
 * enough metadata that callers can introspect the composition.
 */
export interface TemplatePack {
  agent: Agent;
  manifest: PackManifest;
  /** Resolved skills loaded from the pack, after variable interpolation. */
  skills: Skill[];
  /** Resolved routines loaded from the pack, after variable interpolation. */
  routines: Routine[];
  /** Resolved system prompt the agent was configured with. */
  systemPrompt: string;
}
