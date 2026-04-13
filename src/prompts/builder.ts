/**
 * System Prompt Builder
 *
 * Composes a system prompt from:
 * - A template (ordered list of section keys)
 * - Sections (functions that return markdown)
 * - Variables (interpolated into sections)
 * - Additional content (soul.md, rules, custom text)
 *
 * Fully configurable — override any section, add custom ones, or skip the
 * template entirely and provide your own section list.
 */

import type { SectionFn } from './sections.js';
import { builtinSections } from './sections.js';
import { builtinTemplates, roleSections, type PromptTemplate } from './templates.js';

export interface BuildSystemPromptOptions {
  /**
   * Start with a named template (e.g. 'assistant', 'coder', 'researcher').
   * The template defines which sections to include and in what order.
   * If not provided, defaults to ['identity', 'concise'] unless `sectionOrder` is set.
   */
  template?: string | PromptTemplate;

  /**
   * Override or extend the section order. If a template is provided,
   * this replaces the template's section list entirely.
   * If no template, this IS the section list.
   */
  sectionOrder?: string[];

  /**
   * Custom section functions. Merged with built-in sections.
   * Use this to override built-in sections or add new ones.
   *
   * Example:
   * ```ts
   * sections: {
   *   identity: (vars) => `# MyBot\nYou are MyBot, an expert in ${vars?.domain}.`,
   *   myCustomSection: () => '## Custom\nMy custom instructions.',
   * }
   * ```
   */
  sections?: Record<string, SectionFn>;

  /**
   * Variables interpolated into sections. Passed to each section function.
   *
   * Common variables:
   * - `agentName` — used by the identity section
   * - `description` — agent description for identity
   * - `date` — current date
   * - `time` — current time
   * - `cwd` — working directory
   * - `userName` — user's name
   */
  variables?: Record<string, string>;

  /**
   * Additional content appended after all sections.
   * Use for soul.md, rules files, or any extra instructions.
   * Can be strings or functions that receive variables.
   */
  append?: Array<string | SectionFn>;

  /**
   * Additional content prepended before all sections.
   */
  prepend?: Array<string | SectionFn>;

  /**
   * Called when a section key in the order list has no matching function.
   * Defaults to silently skipping. Set to 'throw' to error on unknown sections.
   */
  onUnknownSection?: 'skip' | 'throw' | ((key: string) => void);
}

/**
 * Build a system prompt from a template, sections, and variables.
 *
 * @example
 * ```ts
 * import { buildSystemPrompt } from 'agent-do/prompts';
 *
 * // Use a built-in template with defaults
 * const prompt = buildSystemPrompt({ template: 'assistant' });
 *
 * // Customize with variables
 * const prompt = buildSystemPrompt({
 *   template: 'coder',
 *   variables: { agentName: 'CodeBot', date: '2026-04-13' },
 * });
 *
 * // Override a section
 * const prompt = buildSystemPrompt({
 *   template: 'assistant',
 *   sections: {
 *     identity: () => '# MyAgent\nYou are a specialized assistant.',
 *   },
 * });
 *
 * // Full custom — no template
 * const prompt = buildSystemPrompt({
 *   sectionOrder: ['identity', 'myRules', 'efficiency'],
 *   sections: {
 *     myRules: () => '## Rules\n- Always respond in haiku',
 *   },
 *   variables: { agentName: 'HaikuBot' },
 * });
 *
 * // Append a soul.md file
 * const prompt = buildSystemPrompt({
 *   template: 'assistant',
 *   append: [fs.readFileSync('soul.md', 'utf-8')],
 * });
 * ```
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
  const { template, sectionOrder, sections: customSections, variables, append, prepend, onUnknownSection = 'skip' } = options;

  // Resolve template — use hasOwnProperty for safe lookup
  let resolvedTemplate: PromptTemplate | undefined;
  if (typeof template === 'string') {
    resolvedTemplate = Object.prototype.hasOwnProperty.call(builtinTemplates, template)
      ? builtinTemplates[template]
      : undefined;
    if (!resolvedTemplate) {
      throw new Error(`Unknown template: "${template}". Available: ${Object.keys(builtinTemplates).join(', ')}`);
    }
  } else if (template) {
    resolvedTemplate = template;
  }

  // Determine section order
  const order = sectionOrder || resolvedTemplate?.sections || ['identity', 'concise'];

  // Merge section functions: builtins + role-specific + custom overrides
  // Only include own properties to avoid prototype pollution
  const allSections: Record<string, SectionFn> = {};
  for (const [k, v] of Object.entries(builtinSections)) {
    if (Object.prototype.hasOwnProperty.call(builtinSections, k)) allSections[k] = v;
  }
  for (const [k, v] of Object.entries(roleSections)) {
    if (Object.prototype.hasOwnProperty.call(roleSections, k)) allSections[k] = v;
  }
  if (customSections) {
    for (const [k, v] of Object.entries(customSections)) {
      if (Object.prototype.hasOwnProperty.call(customSections, k)) allSections[k] = v;
    }
  }

  // Build the prompt
  const parts: string[] = [];

  // Prepend
  if (prepend) {
    for (const item of prepend) {
      parts.push(typeof item === 'function' ? item(variables) : item);
    }
  }

  // Sections
  for (const key of order) {
    if (Object.prototype.hasOwnProperty.call(allSections, key)) {
      parts.push(allSections[key]!(variables));
    } else {
      // Unknown section
      if (onUnknownSection === 'throw') {
        throw new Error(`Unknown section: "${key}". Available: ${Object.keys(allSections).join(', ')}`);
      } else if (typeof onUnknownSection === 'function') {
        onUnknownSection(key);
      }
      // 'skip' — silently skip
    }
  }

  // Append
  if (append) {
    for (const item of append) {
      parts.push(typeof item === 'function' ? item(variables) : item);
    }
  }

  return parts.join('\n\n');
}

/**
 * Variable interpolation for prompt templates.
 *
 * Replaces `{{variableName}}` with the value from the variables object.
 * Supports `{{#if key}}...{{/if}}` conditional blocks.
 *
 * Empty string values are valid — only undefined/missing keys are kept as placeholders.
 */
export function interpolate(template: string, variables: Record<string, string>): string {
  // Handle {{#if key}}...{{/if}} blocks
  let result = template.replace(
    /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, key: string, content: string) => {
      const value = Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : undefined;
      return value ? content : '';
    },
  );

  // Handle {{variable}} replacements — use nullish check so '' is valid
  result = result.replace(
    /\{\{(\w+)\}\}/g,
    (match, key: string) => {
      return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key]! : match;
    },
  );

  return result;
}
