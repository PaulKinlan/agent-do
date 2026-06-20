// Core
export { createAgent } from './agent.js';
export { runAgentLoop, streamAgentLoop } from './loop.js';

// MCP (Model Context Protocol) — mount external tool servers
export {
  mountMcpServers,
  namespacedToolName,
  MCP_TOOL_PREFIX,
} from './mcp.js';
export type {
  McpServerConfig,
  McpTransportConfig,
  MountedMcpServers,
} from './mcp.js';

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

// Routines — named prompt-as-macro procedures (#77)
export {
  parseRoutineMd,
  interpolateRoutine,
  createRoutineTools,
  InMemoryRoutineStore,
  FilesystemRoutineStore,
} from './routines.js';
export type { CreateRoutineToolsOptions } from './routines.js';
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

// The three consumer-facing tool factories.
//
// - createMemoryTools — the agent's private scratchpad (memory_*).
// - createWorkspaceTools — real project files (read_file/write_file/...)
//   with a deny-list. Optional `sandbox` option swaps the internal
//   store for a SandboxBackedMemoryStore.
// - createShellTool — a single shell-exec tool wired to a SandboxApi
//   (defaults to host).
//
// `createFileTools` is the raw primitive that workspace-tools is
// built on; it's intentionally not exported here. Reach for
// createWorkspaceTools (with a sandbox if you want isolation) or
// createMemoryTools instead.
export { createWorkspaceTools } from './tools/workspace-tools.js';
export type { WorkspaceToolsOptions } from './tools/workspace-tools.js';
export { createMemoryTools } from './tools/memory-tools.js';
export { createShellTool } from './tools/shell-tool.js';
export type { CreateShellToolOptions } from './tools/shell-tool.js';

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

// Store interfaces and default implementations
export type { MemoryStore, FileEntry, SearchOptions } from './stores.js';
export { InMemoryMemoryStore } from './stores/in-memory.js';
export { FilesystemMemoryStore } from './stores/filesystem.js';
export type { FilesystemMemoryStoreOptions } from './types.js';
// File locking (#15 Tier 1) — opt-in cross-process safety for the filesystem store.
export { acquireFileLock, withFileLock } from './stores/file-lock.js';
export type { FileLockOptionsInternal } from './stores/file-lock.js';
export type { FileLockOptions, LockHandle, LockAdapter } from './types.js';
// Scheduled tasks (#79) — declarative cron-driven agent runs with lock-file concurrency.
export {
  matchesCron,
  validateScheduledTasks,
  readStatus,
  writeStatus,
  recordRun,
  runScheduledTask,
} from './scheduled-tasks.js';
export type { ScheduledTask, ScheduledTasksConfig, TaskStatus, StatusRecord } from './scheduled-tasks.js';
export { SandboxBackedMemoryStore } from './stores/sandbox.js';
export type { SandboxBackedMemoryStoreOptions } from './stores/sandbox.js';

// Sandbox contract + connectors (#3).
export type {
  SandboxApi,
  FileStat,
  ExecOptions,
  ExecResult,
} from './sandbox/types.js';
export {
  createHostSandbox,
  createJustBashSandbox,
  wrapJustBashSandbox,
} from './sandbox/connectors/index.js';
export type {
  HostSandboxOptions,
  CreateJustBashSandboxOptions,
  JustBashSandboxLike,
} from './sandbox/connectors/index.js';

// Prompt builder
export { buildSystemPrompt, interpolate } from './prompts/builder.js';
export { builtinSections } from './prompts/sections.js';
export { builtinTemplates, roleSections } from './prompts/templates.js';
export type { BuildSystemPromptOptions } from './prompts/builder.js';
export type { SectionFn } from './prompts/sections.js';
export type { PromptTemplate } from './prompts/templates.js';
