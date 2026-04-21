/**
 * Pack manifest parsing + schema validation (#78).
 *
 * The manifest lives at `<pack-dir>/pack.json` and is the single
 * source of truth for what a pack contains. Validation here mirrors
 * the same defensive pattern used for `SavedAgentSchema` in
 * `src/cli/agents.ts` — prototype-pollution keys are stripped, path
 * references are confined to the pack directory (no `..` / absolute
 * paths), and unknown top-level keys are rejected so future footguns
 * fail closed.
 */

import { z } from 'zod';
import type { PackManifest } from './types.js';

const PACK_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const PACK_VERSION_MAX = 32;
const PACK_DESCRIPTION_MAX = 512;
const PACK_VARIABLE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Zod schema for a single entry in `skills` / `routines` / `policies`.
 * Entries must be relative paths confined to the pack directory. We
 * also reject absolute paths and `..` segments — a planted `pack.json`
 * could otherwise point at arbitrary filesystem locations and leak
 * their contents into the system prompt.
 */
const PackFileRefSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => !v.startsWith('/') && !v.match(/^[a-zA-Z]:[\\/]/), {
    message: 'must be a relative path (no absolute paths)',
  })
  .refine((v) => !v.split(/[/\\]/).includes('..'), {
    message: 'must not contain `..` segments',
  });

const PackVariableSchema = z
  .object({
    name: z.string().regex(PACK_VARIABLE_NAME_RE).max(64),
    description: z.string().max(256).optional(),
    default: z.string().max(1024).optional(),
    required: z.boolean().optional(),
  })
  .strict();

export const PackManifestSchema = z
  .object({
    name: z.string().regex(PACK_NAME_RE).max(64),
    version: z.string().min(1).max(PACK_VERSION_MAX),
    description: z.string().min(1).max(PACK_DESCRIPTION_MAX),
    roles: z.array(z.string().min(1).max(64)).max(64).optional(),
    skills: z.array(PackFileRefSchema).max(128).optional(),
    routines: z.array(PackFileRefSchema).max(128).optional(),
    policies: z.array(PackFileRefSchema).max(128).optional(),
    mcpServers: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/).max(64)).max(32).optional(),
    tools: z.array(z.enum(['workspace', 'memory'])).max(8).optional(),
    heartbeat: PackFileRefSchema.optional(),
    systemPrompt: z.string().max(32 * 1024).optional(),
    variables: z.array(PackVariableSchema).max(64).optional(),
  })
  .strict();

/**
 * Parse a raw JSON string into a validated {@link PackManifest}.
 *
 * Throws on parse or schema failure with a readable error describing
 * every offending field. Prototype-pollution keys are filtered out of
 * the parsed JSON before validation so a hostile manifest can't
 * inject `__proto__` / `constructor` entries.
 */
export function parsePackManifest(json: string, sourcePath?: string): PackManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json, (key, value) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        return undefined;
      }
      return value;
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Pack manifest${sourcePath ? ` at ${sourcePath}` : ''} is not valid JSON: ${msg}`,
    );
  }

  const parsed = PackManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid pack manifest${sourcePath ? ` at ${sourcePath}` : ''}:\n${issues}`,
    );
  }
  return parsed.data;
}
