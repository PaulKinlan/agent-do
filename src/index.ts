// Core
export { createAgent } from './agent.js';
export { runAgentLoop, streamAgentLoop } from './loop.js';

// Permissions
export { evaluatePermission } from './permissions.js';

// Skills
export {
  buildSkillsPrompt,
  parseSkillMd,
  createSkillTools,
  InMemorySkillStore,
} from './skills.js';

// Workspace tools (real project files) and memory tools (agent scratchpad)
export { createWorkspaceTools } from './tools/workspace-tools.js';
export type { WorkspaceToolsOptions } from './tools/workspace-tools.js';
export { createMemoryTools } from './tools/memory-tools.js';

// Lower-level file tools — backed by any MemoryStore. Prefer
// createWorkspaceTools or createMemoryTools unless you need a custom store.
export { createFileTools } from './tools/file-tools.js';

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
export type { MemoryStore, FileEntry } from './stores.js';
export { InMemoryMemoryStore } from './stores/in-memory.js';
export { FilesystemMemoryStore } from './stores/filesystem.js';
export type { FilesystemMemoryStoreOptions } from './types.js';

// Prompt builder
export { buildSystemPrompt, interpolate } from './prompts/builder.js';
export { builtinSections } from './prompts/sections.js';
export { builtinTemplates, roleSections } from './prompts/templates.js';
export type { BuildSystemPromptOptions } from './prompts/builder.js';
export type { SectionFn } from './prompts/sections.js';
export type { PromptTemplate } from './prompts/templates.js';
