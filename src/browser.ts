/**
 * Browser-safe entry point for agent-do.
 *
 * Separates Node-only helpers (stdio subprocesses, cross-spawn, filesystem
 * stores, host sandbox, file locking) from the pure agent loop, remote MCP
 * (SSE/HTTP), routine/cron helpers, and memory tools.
 */

// Core
export { createAgent } from './agent.js';
export { runAgentLoop, streamAgentLoop } from './loop.js';

// Remote MCP (Model Context Protocol) — SSE and HTTP transports
export {
  mountMcpServers,
  namespacedToolName,
  MCP_TOOL_PREFIX,
} from './mcp-core.js';
export type {
  McpServerConfig,
  McpTransportConfig,
  MountedMcpServers,
} from './mcp-core.js';

// Permissions
export { evaluatePermission } from './permissions.js';

// Skills
export {
  buildSkillsPrompt,
  buildSkillUsageInstruction,
  parseSkillMd,
  createSkillTools,
  InMemorySkillStore,
  resolveSkillsMode,
} from './skills.js';
export type {
  SkillsPromptMode,
  BuildSkillsPromptOptions,
} from './skills.js';

// Routines — pure routines tools & in-memory store
export {
  parseRoutineMd,
  interpolateRoutine,
  createRoutineTools,
  InMemoryRoutineStore,
} from './routines-core.js';
export type { CreateRoutineToolsOptions } from './routines-core.js';
export type { Routine, RoutineStore, RoutineInput } from './types.js';

// Policies — typed system-prompt modules (#80)
export {
  createPolicy,
  parsePolicyMd,
  buildPoliciesPrompt,
  InMemoryPolicyStore,
} from './policies.js';
export type { PolicyInput } from './policies.js';
export type { Policy, PolicyStore } from './types.js';

// Browser-safe tools
export { createMemoryTools } from './tools/memory-tools.js';

// Structured tool results (see issue #48)
export type { ToolResult } from './tools/types.js';
export { normaliseToolResult, isToolResult } from './tools/types.js';

// Usage
export {
  UsageTracker,
  estimateCost,
  DEFAULT_PRICING,
  resetPricingWarnings,
} from './usage.js';

// Orchestrator
export { createOrchestrator } from './orchestrator.js';

// Slash-command router (#76) — deterministic pre-model dispatch.
export {
  parseSlashCommand,
  unknownSlashCommandMessage,
  validateSlashCommands,
} from './slash-commands.js';

// Store interfaces and in-memory implementation
export type { MemoryStore, FileEntry, SearchOptions } from './stores.js';
export { InMemoryMemoryStore } from './stores/in-memory.js';

// Scheduled tasks — pure cron validation and matching
export {
  matchesCron,
  validateScheduledTasks,
} from './scheduled-tasks-core.js';
export type { ScheduledTask, ScheduledTasksConfig, TaskStatus, StatusRecord } from './scheduled-tasks-core.js';

// Prompt builder
export { buildSystemPrompt, interpolate } from './prompts/builder.js';
export { builtinSections } from './prompts/sections.js';
export { builtinTemplates, roleSections } from './prompts/templates.js';
export type { BuildSystemPromptOptions } from './prompts/builder.js';
export type { SectionFn } from './prompts/sections.js';
export type { PromptTemplate } from './prompts/templates.js';

// Types
export type {
  ProgressEvent,
  DebugEvent,
  DebugConfig,
  Skill,
  SkillSearchResult,
  SkillStore,
  UsageRecord,
  RunUsage,
  PermissionLevel,
  PermissionMode,
  PermissionConfig,
  PreToolUseEvent,
  PostToolUseEvent,
  StepStartEvent,
  StepCompleteEvent,
  CompleteEvent,
  HookDecision,
  AgentHooks,
  PricingTable,
  ProviderOptions,
  AgentConfig,
  Agent,
  RunResult,
  ConversationMessage,
} from './types.js';

export type {
  OrchestratorConfig,
  Orchestrator,
} from './orchestrator.js';
