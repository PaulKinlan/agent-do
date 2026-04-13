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

// File tools
export { createFileTools } from './tools/file-tools.js';

// Usage
export { UsageTracker, estimateCost, DEFAULT_PRICING } from './usage.js';

// Orchestrator
export { createOrchestrator } from './orchestrator.js';

// Types
export type {
  ProgressEvent,
  Skill,
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
