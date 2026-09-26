/**
 * Saved Routines: named prompt-as-macro procedures (#77) — core logic.
 *
 * Separated from routines.ts so browser bundles can import the pure
 * routine tools and in-memory store without pulling in Node fs or path.
 */

import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import YAML from 'yaml';
import type { Routine, RoutineInput, RoutineStore } from './types.js';

// ── Frontmatter parsing ────────────────────────────────────────────────

/**
 * Per-field schemas for routine YAML frontmatter.
 *
 * Same independent-validation pattern as `extractSkillMeta` in skills.ts:
 * one bad field (e.g. `version: 2` landing as YAML number) doesn't
 * nuke the rest. String fields coerce from numeric/boolean YAML values.
 */
const ROUTINE_FIELD_SCHEMAS = {
  name: z.coerce.string().min(1).max(64),
  description: z.coerce.string().max(512),
  version: z.coerce.string().max(32),
} as const;

export const ROUTINE_BODY_MAX = 16 * 1024;

/** Input arg metadata. Keeping it lightweight — name + optional. */
const RoutineInputSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(256).optional(),
  optional: z.boolean().optional(),
});

type RoutineMeta = {
  name?: string;
  description?: string;
  version?: string;
  inputs?: RoutineInput[];
};

function extractRoutineMeta(raw: unknown): RoutineMeta {
  if (typeof raw !== 'object' || raw === null) return {};
  const lowered: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    lowered[k.toLowerCase()] = v;
  }

  const out: RoutineMeta = {};
  for (const field of Object.keys(ROUTINE_FIELD_SCHEMAS) as Array<
    keyof typeof ROUTINE_FIELD_SCHEMAS
  >) {
    const value = lowered[field];
    if (value === undefined || value === null) continue;
    const parsed = ROUTINE_FIELD_SCHEMAS[field].safeParse(value);
    if (parsed.success) out[field] = parsed.data;
  }

  const rawInputs = lowered.inputs;
  if (Array.isArray(rawInputs)) {
    const kept: RoutineInput[] = [];
    for (const entry of rawInputs) {
      const parsed = RoutineInputSchema.safeParse(entry);
      if (parsed.success) kept.push(parsed.data);
    }
    if (kept.length > 0) out.inputs = kept;
  }

  return out;
}

/**
 * Parse a routine markdown file with YAML frontmatter. Same shape as
 * {@link parseSkillMd} in `./skills.ts` — falls back to body-only when
 * there's no frontmatter.
 */
export function parseRoutineMd(content: string, id?: string): Routine {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);

  if (!match) {
    const generatedId = id || 'unknown-routine';
    return {
      id: generatedId,
      name: generatedId,
      description: '',
      body: clampBody(content.trim()),
      runCount: 0,
    };
  }

  const frontmatter = match[1];
  const body = clampBody(match[2].trim());

  let rawMeta: unknown = {};
  try {
    rawMeta = YAML.parse(frontmatter) ?? {};
  } catch {
    rawMeta = {};
  }
  const meta = extractRoutineMeta(rawMeta);

  const routineId =
    id ||
    meta.name
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') ||
    'unknown-routine';

  return {
    id: routineId,
    name: meta.name || routineId,
    description: meta.description || '',
    body,
    inputs: meta.inputs,
    version: meta.version,
    runCount: 0,
  };
}

function clampBody(body: string): string {
  return body.length > ROUTINE_BODY_MAX ? body.slice(0, ROUTINE_BODY_MAX) : body;
}

/**
 * Substitute `{{name}}` placeholders in a routine body with the
 * provided args. Unknown placeholders are left in place — that way the
 * model can see which args it needs to gather before running.
 *
 * Deliberately minimal: no conditionals, loops, or expressions. Keep
 * the prompt-is-the-program ethos — a routine is a prompt, not a DSL.
 */
export function interpolateRoutine(
  body: string,
  args: Record<string, unknown>,
): string {
  return body.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      const v = args[key];
      return typeof v === 'string' ? v : JSON.stringify(v);
    }
    return match; // leave unknown placeholder visible
  });
}

// ── Tools exposed to the LLM ───────────────────────────────────────────

export const ROUTINE_ID_RE = /^[a-zA-Z0-9_-]+$/;
export const ROUTINE_ID_MAX = 64;
export const ROUTINE_NAME_MAX = 64;
export const ROUTINE_DESCRIPTION_MAX = 256;

/**
 * IDs that collide with `Object.prototype` members. Even though the
 * store now validates/guards these paths, the best fix is to reject
 * them at the entry point so a hostile id never reaches the store
 * (Codex #77 review). Includes the classic prototype-pollution keys
 * and a couple of filesystem gotchas (`.` / `..` already fail the
 * regex, but kept for readers).
 */
export const RESERVED_ROUTINE_IDS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'hasOwnProperty',
  'toString',
  'valueOf',
]);

export function isValidRoutineId(id: string): boolean {
  return ROUTINE_ID_RE.test(id) && !RESERVED_ROUTINE_IDS.has(id);
}

export const SaveRoutineInputSchema = z.object({
  id: z
    .string()
    .regex(ROUTINE_ID_RE)
    .max(ROUTINE_ID_MAX)
    .refine((id) => !RESERVED_ROUTINE_IDS.has(id), {
      message: 'Routine ID collides with a reserved name',
    })
    .describe('Unique routine ID (kebab-case; alphanumerics, dashes, underscores only)'),
  name: z.string().min(1).max(ROUTINE_NAME_MAX).describe('Human-readable routine name'),
  description: z
    .string()
    .max(ROUTINE_DESCRIPTION_MAX)
    .describe('What the routine does — shown in list_routines output'),
  body: z
    .string()
    .max(ROUTINE_BODY_MAX)
    .describe('The routine instructions (markdown, max 16 KB)'),
});

export interface CreateRoutineToolsOptions {
  /**
   * Allow the LLM to call `save_routine`.
   *
   * Default `false`: save is privileged because a prompt-injected agent
   * could persistently install a hostile "routine" that future runs
   * would execute when the user invokes it by name. Same threat model
   * as `allowSkillInstall`.
   */
  allowSave?: boolean;
}

/**
 * Build the AI SDK tools that expose a routine store to the model.
 *
 * Always exposed:
 *   - `list_routines` — id / name / description per routine
 *   - `run_routine(id, args?)` — returns the routine body with
 *     `{{arg}}` placeholders interpolated
 *
 * Gated behind `allowSave: true`:
 *   - `save_routine` — persist a new routine to the store
 */
export function createRoutineTools(
  store: RoutineStore,
  options: CreateRoutineToolsOptions = {},
): ToolSet {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = (schema: z.ZodType): any => schema;

  const tools: ToolSet = {
    list_routines: tool({
      description:
        'List all saved routines — named procedures the user has previously captured. Each entry shows id/name/description. To execute one, call run_routine(id).',
      inputSchema: s(z.object({})),
      execute: async () => {
        const routines = await store.list();
        if (routines.length === 0) {
          return 'No routines saved.';
        }
        return routines
          .map(
            (r) =>
              `- ${r.name} (${r.id}): ${r.description} [runs: ${r.runCount}]`,
          )
          .join('\n');
      },
    }),

    run_routine: tool({
      description:
        'Retrieve and run a saved routine by ID. Returns the routine body with any {{arg}} placeholders filled from the `args` object. Follow the returned instructions to complete the task. Use list_routines to see what\'s available.',
      inputSchema: s(
        z.object({
          routineId: z.string().describe('ID of the routine to run'),
          args: z
            .record(z.string(), z.unknown())
            .optional()
            .describe('Optional argument map used to fill {{placeholders}} in the routine body'),
        }),
      ),
      execute: async ({
        routineId,
        args,
      }: {
        routineId: string;
        args?: Record<string, unknown>;
      }) => {
        const routine = await store.get(routineId);
        if (!routine) {
          return `Routine "${routineId}" not found. Call list_routines to see available routines.`;
        }
        // Run tracking is observational — persistence failures shouldn't
        // block the routine body from being returned to the model
        // (Copilot #77 review). If the filesystem throws EACCES on
        // .runs.json, the user still gets their routine.
        try {
          await store.recordRun(routineId);
        } catch {
          /* observational; keep going */
        }
        const body = interpolateRoutine(routine.body, args ?? {});
        return `<routine name="${escapeAttr(routine.name)}" id="${escapeAttr(routine.id)}">\n${escapeRoutineBody(body)}\n</routine>`;
      },
    }),
  };

  if (options.allowSave) {
    tools.save_routine = tool({
      description:
        'Save a new routine — a named prompt-as-macro the user can invoke later by name. The body is the recipe the routine will run; use {{name}} placeholders for arguments.',
      inputSchema: s(SaveRoutineInputSchema),
      execute: async (raw: unknown) => {
        const parsed = SaveRoutineInputSchema.safeParse(raw);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ');
          return `Error: save_routine rejected — ${issues}`;
        }
        await store.save({
          id: parsed.data.id,
          name: parsed.data.name,
          description: parsed.data.description,
          body: parsed.data.body,
          runCount: 0,
        });
        return `Routine "${parsed.data.name}" (${parsed.data.id}) saved successfully.`;
      },
    });
  }

  return tools;
}

function escapeAttr(value: string): string {
  return value.replace(/["<>\n\r]/g, ' ').slice(0, 128);
}

/**
 * Neutralise `<routine>` sequences in the body so a routine that
 * contains `</routine>` + jailbreak text can't escape the container.
 * Same rationale as `escapeSkillBody` in skills.ts.
 */
function escapeRoutineBody(value: string): string {
  return value
    .replace(/<\/routine\b/gi, '</ routine')
    .replace(/<routine\b/gi, '< routine');
}

// ── Stores ─────────────────────────────────────────────────────────────

/**
 * In-memory reference implementation of {@link RoutineStore}.
 */
export class InMemoryRoutineStore implements RoutineStore {
  private routines = new Map<string, Routine>();

  async list(): Promise<Routine[]> {
    return Array.from(this.routines.values());
  }

  async get(id: string): Promise<Routine | undefined> {
    return this.routines.get(id);
  }

  async save(routine: Routine): Promise<void> {
    this.routines.set(routine.id, {
      ...routine,
      runCount: routine.runCount ?? 0,
    });
  }

  async remove(id: string): Promise<void> {
    this.routines.delete(id);
  }

  async recordRun(id: string): Promise<void> {
    const existing = this.routines.get(id);
    if (!existing) return;
    this.routines.set(id, {
      ...existing,
      runCount: (existing.runCount ?? 0) + 1,
      lastRun: new Date().toISOString(),
    });
  }
}
