import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import YAML from 'yaml';
import type { Skill, SkillStore, SkillSearchResult } from './types.js';

/**
 * Per-field schemas for the frontmatter block of a SKILL.md file.
 *
 * Validating field-by-field (rather than the whole object at once) means a
 * single bad value — e.g. `version: 2` landing as a YAML number — only
 * drops that one field, leaving the rest of the metadata intact. Each
 * schema uses `z.coerce.string()` so numeric/boolean YAML values are
 * stringified rather than rejected. Length caps are upper bounds; oversize
 * values are dropped. Unknown keys are preserved by callers that want them
 * but ignored for the typed `Skill` fields.
 *
 * See issue #37 — the previous hand-rolled parser silently truncated
 * values at colons and dropped multiline fields.
 */
const SKILL_FIELD_SCHEMAS = {
  name: z.coerce.string().min(1).max(128),
  description: z.coerce.string().max(512),
  author: z.coerce.string().max(128),
  version: z.coerce.string().max(32),
} as const;

type SkillMeta = Partial<Record<keyof typeof SKILL_FIELD_SCHEMAS, string>>;

/**
 * Pull the known frontmatter fields out of a parsed YAML object.
 *
 * - Lowercases keys so `Name:` / `DESCRIPTION:` still parse (matching the
 *   pre-v0.1.4 behaviour).
 * - Validates each field independently, so one bad field doesn't lose the
 *   others.
 * - Skips prototype-pollution keys defensively.
 */
function extractSkillMeta(raw: unknown): SkillMeta {
  if (typeof raw !== 'object' || raw === null) return {};

  const lowered: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    lowered[k.toLowerCase()] = v;
  }

  const out: SkillMeta = {};
  for (const field of Object.keys(SKILL_FIELD_SCHEMAS) as Array<keyof typeof SKILL_FIELD_SCHEMAS>) {
    const value = lowered[field];
    if (value === undefined || value === null) continue;
    const parsed = SKILL_FIELD_SCHEMAS[field].safeParse(value);
    if (parsed.success) out[field] = parsed.data;
    // else: skip this field only, keep the others
  }
  return out;
}

/**
 * Build a system prompt section from a list of skills.
 */
export function buildSkillsPrompt(skills: Skill[]): string {
  if (skills.length === 0) return '';

  const parts: string[] = ['\n---\n\n## Installed Skills\n'];

  for (const skill of skills) {
    parts.push(`### Skill: ${skill.name}\n`);
    if (skill.description) {
      parts.push(`> ${skill.description}\n`);
    }
    parts.push(skill.content);
    parts.push('');
  }

  return parts.join('\n');
}

/**
 * Parse a SKILL.md file with YAML frontmatter into a Skill object.
 *
 * Expected format:
 * ```
 * ---
 * name: My Skill
 * description: Does things
 * author: Someone
 * version: 1.0.0
 * ---
 *
 * Skill content here...
 * ```
 */
export function parseSkillMd(content: string, id?: string): Skill {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);

  if (!match) {
    // No frontmatter — treat entire content as the skill body
    const generatedId = id || 'unknown-skill';
    return {
      id: generatedId,
      name: generatedId,
      description: '',
      content: content.trim(),
    };
  }

  const frontmatter = match[1];
  const body = match[2];

  // Proper YAML parsing. On parse error (malformed frontmatter) fall back
  // to an empty object so the body is still returned rather than the whole
  // skill being dropped. Per-field validation happens in extractSkillMeta.
  let rawMeta: unknown = {};
  try {
    rawMeta = YAML.parse(frontmatter) ?? {};
  } catch {
    rawMeta = {};
  }
  const meta = extractSkillMeta(rawMeta);

  const skillId =
    id ||
    meta.name
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') ||
    'unknown-skill';

  return {
    id: skillId,
    name: meta.name || skillId,
    description: meta.description || '',
    content: body.trim(),
    author: meta.author,
    version: meta.version,
  };
}

/**
 * Create Vercel AI SDK tools for skill management.
 */
export function createSkillTools(store: SkillStore): ToolSet {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = (schema: z.ZodType): any => schema;

  return {
    search_skills: tool({
      description:
        'Search for skills that can enhance your capabilities. Returns matching skills from the registry.',
      inputSchema: s(
        z.object({
          query: z
            .string()
            .describe('Search query for finding relevant skills'),
        }),
      ),
      execute: async ({ query }: { query: string }) => {
        const results = await store.search(query);
        if (results.length === 0) {
          return `No skills found matching "${query}"`;
        }
        return JSON.stringify(results, null, 2);
      },
    }),

    install_skill: tool({
      description: 'Install a skill by providing its full definition.',
      inputSchema: s(
        z.object({
          id: z.string().describe('Unique skill ID (kebab-case)'),
          name: z.string().describe('Human-readable skill name'),
          description: z.string().describe('What the skill does'),
          content: z.string().describe('The skill instructions/content'),
        }),
      ),
      execute: async ({
        id,
        name,
        description,
        content,
      }: {
        id: string;
        name: string;
        description: string;
        content: string;
      }) => {
        await store.install({ id, name, description, content });
        return `Skill "${name}" (${id}) installed successfully.`;
      },
    }),

    list_skills: tool({
      description: 'List all currently installed skills.',
      inputSchema: s(z.object({})),
      execute: async () => {
        const skills = await store.list();
        if (skills.length === 0) {
          return 'No skills installed.';
        }
        return skills
          .map((sk) => `- ${sk.name} (${sk.id}): ${sk.description}`)
          .join('\n');
      },
    }),

    remove_skill: tool({
      description: 'Remove an installed skill by ID.',
      inputSchema: s(
        z.object({
          skillId: z.string().describe('ID of the skill to remove'),
        }),
      ),
      execute: async ({ skillId }: { skillId: string }) => {
        const existing = await store.get(skillId);
        if (!existing) {
          return `Skill "${skillId}" not found.`;
        }
        await store.remove(skillId);
        return `Skill "${skillId}" removed.`;
      },
    }),
  };
}

/**
 * In-memory reference implementation of SkillStore.
 */
export class InMemorySkillStore implements SkillStore {
  private skills: Map<string, Skill> = new Map();

  async list(): Promise<Skill[]> {
    return Array.from(this.skills.values());
  }

  async get(skillId: string): Promise<Skill | undefined> {
    return this.skills.get(skillId);
  }

  async install(skill: Skill): Promise<void> {
    this.skills.set(skill.id, skill);
  }

  async remove(skillId: string): Promise<void> {
    this.skills.delete(skillId);
  }

  async search(query: string): Promise<SkillSearchResult[]> {
    const lower = query.toLowerCase();
    const results: SkillSearchResult[] = [];
    for (const skill of this.skills.values()) {
      if (
        skill.name.toLowerCase().includes(lower) ||
        skill.description.toLowerCase().includes(lower) ||
        skill.content.toLowerCase().includes(lower)
      ) {
        results.push({
          id: skill.id,
          name: skill.name,
          description: skill.description,
        });
      }
    }
    return results;
  }
}
