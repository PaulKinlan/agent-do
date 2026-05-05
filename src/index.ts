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

// Workspace tools (real project files) and memory tools (agent scratchpad)
export { createWorkspaceTools } from './tools/workspace-tools.js';
export type { WorkspaceToolsOptions } from './tools/workspace-tools.js';
export { createMemoryTools } from './tools/memory-tools.js';

// Lower-level file tools — backed by any MemoryStore. Prefer
// createWorkspaceTools or createMemoryTools unless you need a custom store.
export { createFileTools } from './tools/file-tools.js';
export type { FileToolsOptions } from './tools/file-tools.js';

// Sandbox tools — `bash` plus the convenience bundle that wires
// file tools through a SandboxBackedMemoryStore (#3).
export { createBashTool } from './tools/bash-tool.js';
export type { CreateBashToolOptions } from './tools/bash-tool.js';
export { createSandboxedToolset } from './tools/sandboxed-toolset.js';
export type { CreateSandboxedToolsetOptions } from './tools/sandboxed-toolset.js';

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
  createNoopSandbox,
  createJustBashSandbox,
  wrapJustBashSandbox,
  createSandboxRuntimeSandbox,
  createVercelSandbox,
  createDenoSandbox,
} from './sandbox/connectors/index.js';
export type {
  NoopSandboxOptions,
  CreateJustBashSandboxOptions,
  JustBashSandboxLike,
  SandboxRuntimeOptions,
  CreateVercelSandboxOptions,
  VercelSandboxLike,
  CreateDenoSandboxOptions,
} from './sandbox/connectors/index.js';

// Prompt builder
export { buildSystemPrompt, interpolate } from './prompts/builder.js';
export { builtinSections } from './prompts/sections.js';
export { builtinTemplates, roleSections } from './prompts/templates.js';
export type { BuildSystemPromptOptions } from './prompts/builder.js';
export type { SectionFn } from './prompts/sections.js';
export type { PromptTemplate } from './prompts/templates.js';
