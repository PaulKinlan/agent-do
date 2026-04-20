/**
 * Saved Routines: named prompt-as-macro procedures (#77).
 *
 * A routine is a named saved procedure — a step-by-step recipe stored in
 * markdown with YAML frontmatter and invoked *explicitly by name*.
 * Routines are distinct from skills:
 *
 *   Skills fire *autonomously* — the model matches a skill's description
 *   against the task and applies it. Routines fire *deterministically* —
 *   the model (or the CLI, or external code) calls `run_routine(id, args)`
 *   and the returned body is the procedure to follow.
 *
 * Routines accumulate over time: `recordRun()` tracks `runCount` and
 * `lastRun`, enabling future "I've done this 3 times, save it as a
 * routine?" agent-proposed capture. The capture UX is out of scope for
 * this first pass — we ship the primitive, not the detector.
 *
 * Storage format:
 * ```
 * ---
 * name: weekly-report
 * description: Summarise the last 7 daily entries into a weekly rollup
 * inputs:
 *   - name: week
 *     optional: true
 * version: 1
 * ---
 *
 * For a weekly report:
 * 1. Read the last 7 daily entries from entries/
 * 2. Group by Events / People / Decisions / Open Threads
 * 3. Write to reports/weekly-{{week}}.md
 * ```
 */

import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import YAML from 'yaml';
import type { Routine, RoutineInput, RoutineStore } from './types.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

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

const ROUTINE_BODY_MAX = 16 * 1024;

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

const ROUTINE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const ROUTINE_ID_MAX = 64;
const ROUTINE_NAME_MAX = 64;
const ROUTINE_DESCRIPTION_MAX = 256;

/**
 * IDs that collide with `Object.prototype` members. Even though the
 * store now validates/guards these paths, the best fix is to reject
 * them at the entry point so a hostile id never reaches the store
 * (Codex #77 review). Includes the classic prototype-pollution keys
 * and a couple of filesystem gotchas (`.` / `..` already fail the
 * regex, but kept for readers).
 */
const RESERVED_ROUTINE_IDS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'hasOwnProperty',
  'toString',
  'valueOf',
]);

function isValidRoutineId(id: string): boolean {
  return ROUTINE_ID_RE.test(id) && !RESERVED_ROUTINE_IDS.has(id);
}

const SaveRoutineInputSchema = z.object({
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

/**
 * Filesystem-backed {@link RoutineStore}. Routines are stored as
 * `<rootDir>/<id>.md` with YAML frontmatter.
 *
 * Run metadata (`runCount`, `lastRun`) lives in
 * `<rootDir>/.runs.json` — a single sidecar file so we're not
 * rewriting SKILL.md-shaped routine files every time a run completes.
 */
export class FilesystemRoutineStore implements RoutineStore {
  private runsCache: Record<string, { runCount: number; lastRun?: string }> | undefined;

  constructor(private readonly rootDir: string) {}

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  private runsFile(): string {
    return join(this.rootDir, '.runs.json');
  }

  private async loadRuns(): Promise<
    Record<string, { runCount: number; lastRun?: string }>
  > {
    if (this.runsCache) return this.runsCache;
    // Null-prototype object so keys like `__proto__` / `constructor` /
    // `prototype` can't shadow Object.prototype members from a hostile
    // sidecar file (Copilot #77 review). Also validates per-entry so a
    // malformed runCount (negative, float, NaN, non-number) doesn't
    // corrupt subsequent increments.
    const cache: Record<string, { runCount: number; lastRun?: string }> =
      Object.create(null);
    try {
      const raw = await fs.readFile(this.runsFile(), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [routineId, rawValue] of Object.entries(parsed)) {
          if (
            routineId === '__proto__' ||
            routineId === 'constructor' ||
            routineId === 'prototype'
          ) {
            continue;
          }
          if (!isValidRoutineId(routineId)) continue;
          if (typeof rawValue !== 'object' || rawValue === null) continue;
          const candidate = rawValue as {
            runCount?: unknown;
            lastRun?: unknown;
          };
          if (
            !Number.isSafeInteger(candidate.runCount) ||
            (candidate.runCount as number) < 0
          ) {
            continue;
          }
          const entry: { runCount: number; lastRun?: string } = {
            runCount: candidate.runCount as number,
          };
          if (typeof candidate.lastRun === 'string') {
            entry.lastRun = candidate.lastRun;
          }
          cache[routineId] = entry;
        }
      }
    } catch {
      // Missing file / malformed JSON → start fresh. Runs tracking is
      // observational; lost counts aren't a correctness problem.
    }
    this.runsCache = cache;
    return cache;
  }

  private async saveRuns(): Promise<void> {
    if (!this.runsCache) return;
    await this.ensureDir();
    await fs.writeFile(this.runsFile(), JSON.stringify(this.runsCache, null, 2), 'utf8');
  }

  async list(): Promise<Routine[]> {
    await this.ensureDir();
    const entries = await fs.readdir(this.rootDir);
    const runs = await this.loadRuns();
    const routines: Routine[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const id = entry.replace(/\.md$/, '');
      if (!isValidRoutineId(id)) continue;
      const content = await fs.readFile(join(this.rootDir, entry), 'utf8');
      const routine = parseRoutineMd(content, id);
      const runData = runs[id];
      if (runData) {
        routine.runCount = runData.runCount;
        routine.lastRun = runData.lastRun;
      }
      routines.push(routine);
    }
    return routines;
  }

  async get(id: string): Promise<Routine | undefined> {
    if (!isValidRoutineId(id)) return undefined;
    try {
      const content = await fs.readFile(join(this.rootDir, `${id}.md`), 'utf8');
      const routine = parseRoutineMd(content, id);
      const runs = await this.loadRuns();
      const runData = runs[id];
      if (runData) {
        routine.runCount = runData.runCount;
        routine.lastRun = runData.lastRun;
      }
      return routine;
    } catch {
      return undefined;
    }
  }

  async save(routine: Routine): Promise<void> {
    if (!isValidRoutineId(routine.id)) {
      throw new TypeError(
        `Routine ID "${routine.id}" must match ${ROUTINE_ID_RE} and not be a reserved name`,
      );
    }
    await this.ensureDir();
    const frontmatter = YAML.stringify({
      name: routine.name,
      description: routine.description,
      ...(routine.version ? { version: routine.version } : {}),
      ...(routine.inputs ? { inputs: routine.inputs } : {}),
    });
    const body = `---\n${frontmatter}---\n\n${routine.body}\n`;
    await fs.writeFile(join(this.rootDir, `${routine.id}.md`), body, 'utf8');

    const runs = await this.loadRuns();
    if (!runs[routine.id]) {
      runs[routine.id] = {
        runCount: routine.runCount ?? 0,
        lastRun: routine.lastRun,
      };
      await this.saveRuns();
    }
  }

  async remove(id: string): Promise<void> {
    if (!isValidRoutineId(id)) return;
    try {
      await fs.unlink(join(this.rootDir, `${id}.md`));
    } catch {
      // Missing file — treat remove() as idempotent.
    }
    const runs = await this.loadRuns();
    if (runs[id]) {
      delete runs[id];
      await this.saveRuns();
    }
  }

  async recordRun(id: string): Promise<void> {
    // Contract: `recordRun` is a no-op for missing routines. Without
    // this check the sidecar could grow entries for routines that never
    // existed (direct attacker-controlled IDs via a hostile `run_routine`
    // call, or IDs the caller passed directly before saving). Also
    // refuse IDs that fail the safe-char regex so prototype-polluting
    // keys like `__proto__` can't enter `.runs.json` this way
    // (Copilot + Codex #77 reviews).
    if (!isValidRoutineId(id)) return;
    try {
      await fs.access(join(this.rootDir, `${id}.md`));
    } catch {
      return; // routine file doesn't exist → no-op
    }
    const runs = await this.loadRuns();
    const existing = runs[id] ?? { runCount: 0 };
    runs[id] = {
      runCount: existing.runCount + 1,
      lastRun: new Date().toISOString(),
    };
    await this.saveRuns();
  }
}
