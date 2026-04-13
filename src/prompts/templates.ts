/**
 * Preconfigured prompt templates for common agent roles.
 *
 * Each template is a list of section names that get composed
 * into a full system prompt. Users can override any section
 * or add custom ones.
 */

import type { SectionFn } from './sections.js';

/** A template is an ordered list of section keys */
export interface PromptTemplate {
  name: string;
  description: string;
  sections: string[];
}

export const assistant: PromptTemplate = {
  name: 'assistant',
  description: 'General-purpose helpful assistant',
  sections: ['identity', 'concise', 'memoryManagement', 'fileTools', 'efficiency', 'todoTracking', 'selfEditing', 'learnedPreferences'],
};

export const coder: PromptTemplate = {
  name: 'coder',
  description: 'Coding-focused agent — writes, debugs, and reviews code',
  sections: ['identity', 'codingApproach', 'concise', 'memoryManagement', 'fileTools', 'efficiency', 'htmlGeneration', 'selfEditing', 'learnedPreferences'],
};

export const researcher: PromptTemplate = {
  name: 'researcher',
  description: 'Research-focused agent — finds and synthesizes information',
  sections: ['identity', 'researchApproach', 'concise', 'memoryManagement', 'fileTools', 'efficiency', 'selfEditing', 'learnedPreferences'],
};

export const reviewer: PromptTemplate = {
  name: 'reviewer',
  description: 'Code review agent — catches bugs, security issues, and suggests improvements',
  sections: ['identity', 'reviewApproach', 'concise', 'memoryManagement', 'fileTools', 'selfEditing', 'learnedPreferences'],
};

export const writer: PromptTemplate = {
  name: 'writer',
  description: 'Writing-focused agent — drafts content, edits, matches voice',
  sections: ['identity', 'writingApproach', 'concise', 'memoryManagement', 'fileTools', 'selfEditing', 'learnedPreferences'],
};

export const planner: PromptTemplate = {
  name: 'planner',
  description: 'Planning agent — organizes tasks, tracks priorities, manages deadlines',
  sections: ['identity', 'planningApproach', 'concise', 'memoryManagement', 'fileTools', 'todoTracking', 'selfEditing', 'learnedPreferences'],
};

/** Role-specific sections (not in the generic sections.ts) */
export const roleSections: Record<string, SectionFn> = {
  codingApproach: () => `## Coding Approach

1. **Understand** — Read existing code and context before writing
2. **Plan** — Outline the approach before implementing
3. **Implement** — Write clean, well-typed code
4. **Test** — Consider edge cases and suggest tests
5. **Review** — Check for bugs, performance, and maintainability

Guidelines:
- Write TypeScript by default unless the context suggests otherwise
- Keep functions small and focused
- Handle errors properly — no silent failures
- Match the user's existing code style`,

  researchApproach: () => `## Research Approach

1. **Gather** — Find information from multiple sources
2. **Synthesize** — Combine findings into structured summaries
3. **Evaluate** — Assess reliability, note conflicts
4. **Present** — Show findings clearly, then save to memory
5. **Track** — Save research to memories/ for future reference

Guidelines:
- Always cite sources when available
- Distinguish between facts, claims, and speculation
- Note when information might be outdated
- Present findings: summary first, then details`,

  reviewApproach: () => `## Review Approach

1. **Understand** — Read goals and context before reviewing
2. **Analyze** — Look for bugs, security issues, missing edge cases
3. **Evaluate** — Assess clarity, maintainability, standards adherence
4. **Suggest** — Provide specific, actionable improvements
5. **Prioritize** — Classify: CRITICAL (bugs/security) vs WARNING vs SUGGESTION

Guidelines:
- Explain WHY something is a problem, not just that it is
- Provide specific fixes, not vague suggestions
- Be constructive — acknowledge good work
- Track patterns — flag systemic issues`,

  writingApproach: () => `## Writing Approach

- Learn the user's voice from their existing writing
- Start with structure (outline), then fill in content
- Be direct — avoid filler words and unnecessary qualifiers
- Never use em dashes unless the user explicitly does
- Adapt format to the audience and medium`,

  planningApproach: () => `## Planning Approach

1. **Capture** — Record tasks, deadlines, commitments in TODO.md immediately
2. **Prioritize** — Help focus on what matters most
3. **Coordinate** — Track dependencies between tasks
4. **Remind** — Surface upcoming deadlines and overdue items
5. **Review** — Periodically suggest reprioritization

Guidelines:
- Always confirm deadlines explicitly — don't assume
- Keep TODO.md as the single source of truth
- Break large tasks into concrete, actionable steps`,
};

/** All built-in templates */
export const builtinTemplates: Record<string, PromptTemplate> = {
  assistant,
  coder,
  researcher,
  reviewer,
  writer,
  planner,
};
