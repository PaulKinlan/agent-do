/**
 * Prompt builder — composable system prompts from templates, sections, and variables.
 *
 * @example
 * ```ts
 * import { buildSystemPrompt, builtinTemplates, builtinSections } from 'agent-do/prompts';
 *
 * const prompt = buildSystemPrompt({
 *   template: 'assistant',
 *   variables: { agentName: 'MyBot', date: '2026-04-13' },
 * });
 * ```
 */

export { buildSystemPrompt, interpolate, type BuildSystemPromptOptions } from './builder.js';
export { builtinSections, type SectionFn } from './sections.js';
export { builtinTemplates, roleSections, type PromptTemplate } from './templates.js';
