/**
 * Pack loader — discover pack directories and parse their contents (#78).
 *
 * Packs live in one of two places at runtime:
 *
 *   1. Bundled — the `packs/` directory inside the installed
 *      `agent-do` package. Resolved by walking up from this module's
 *      own location until we find a `package.json` with the
 *      `agent-do` name.
 *   2. User-installed — `.agent-do/packs/<name>/` in the caller's
 *      project. Populated by `agent-do install <pack>`.
 *
 * The loader is provider-agnostic — it doesn't care about models,
 * MCP, or tools. It returns a {@link LoadedPack} with parsed skills,
 * routines, and raw policy bodies. Composition happens in `create.ts`.
 */

import { promises as fs, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePackManifest } from './manifest.js';
import { parseSkillMd } from '../skills.js';
import { parseRoutineMd } from '../routines.js';
import type { LoadedPack, PackManifest } from './types.js';

/**
 * Walk up from `startDir` to find the agent-do package root — the
 * first directory with a `package.json` whose `name` is `agent-do`.
 * Caches the result per-process since it never changes.
 *
 * Works from both the compiled `dist/src/packs/loader.js` path and
 * from `src/packs/loader.ts` when the tests run directly off source.
 */
let cachedBundledDir: string | null | undefined;

export function findBundledPacksDir(): string | null {
  if (cachedBundledDir !== undefined) return cachedBundledDir;
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    cachedBundledDir = null;
    return null;
  }
  for (let i = 0; i < 15; i++) {
    const pkgJson = join(dir, 'package.json');
    if (existsSync(pkgJson)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as { name?: string };
        if (pkg.name === 'agent-do') {
          const packsDir = join(dir, 'packs');
          if (existsSync(packsDir)) {
            cachedBundledDir = packsDir;
            return packsDir;
          }
        }
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedBundledDir = null;
  return null;
}

/**
 * Resolve where a named pack lives on disk. Search order:
 *
 *   1. If `options.packsDir` is provided, use it verbatim — no
 *      fallback. Used by tests and by the CLI's install path when it
 *      already knows which root to read from.
 *   2. `<cwd>/.agent-do/packs/<name>/` — user-installed packs.
 *   3. Bundled `<agent-do-pkg>/packs/<name>/` — shipped with the
 *      library.
 *
 * Returns the absolute pack directory or `null` if not found.
 */
export function resolvePackDir(
  name: string,
  options: { packsDir?: string; cwd?: string } = {},
): string | null {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) return null;
  if (options.packsDir) {
    const dir = isAbsolute(options.packsDir)
      ? options.packsDir
      : resolve(options.cwd ?? process.cwd(), options.packsDir);
    const candidate = join(dir, name);
    return existsSync(candidate) ? candidate : null;
  }
  const cwd = options.cwd ?? process.cwd();
  const userInstalled = resolve(cwd, '.agent-do', 'packs', name);
  if (existsSync(userInstalled)) return userInstalled;
  const bundled = findBundledPacksDir();
  if (bundled) {
    const bundledPack = join(bundled, name);
    if (existsSync(bundledPack)) return bundledPack;
  }
  return null;
}

async function readFileIfExists(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Candidate filesystem paths for a file reference in the manifest.
 *
 * `basename-without-extension` is the ergonomic form — manifest
 * authors write `priority-triage` and we look for
 * `skills/priority-triage.md`. Explicit relative paths (with or
 * without extension) also work. We always resolve relative to the
 * subfolder (`skills/`, `routines/`, `policies/`).
 */
function candidatePaths(subdir: string, ref: string): string[] {
  const withExt = /\.(md|markdown)$/i.test(ref) ? [ref] : [`${ref}.md`, ref];
  const paths: string[] = [];
  for (const p of withExt) {
    paths.push(join(subdir, p));
  }
  return paths;
}

async function loadFileByRef(
  packDir: string,
  subdir: string,
  ref: string,
): Promise<{ path: string; content: string } | null> {
  for (const candidate of candidatePaths(subdir, ref)) {
    const full = join(packDir, candidate);
    const content = await readFileIfExists(full);
    if (content !== null) return { path: full, content };
  }
  return null;
}

/**
 * Load a pack from disk by name. Throws if the pack is missing, the
 * manifest is malformed, or a file reference can't be resolved.
 */
export async function loadPack(
  name: string,
  options: { packsDir?: string; cwd?: string } = {},
): Promise<LoadedPack> {
  const packDir = resolvePackDir(name, options);
  if (!packDir) {
    throw new Error(
      `Pack "${name}" not found. Looked in:\n` +
      `  - ${resolve(options.cwd ?? process.cwd(), '.agent-do/packs', name)} (user-installed)\n` +
      `  - bundled packs directory inside agent-do\n` +
      `Run \`agent-do list-packs\` to see what's available.`,
    );
  }
  return loadPackFromDir(packDir);
}

/**
 * Load a pack from an explicit directory. Lower-level than
 * {@link loadPack} — skips name resolution.
 */
export async function loadPackFromDir(packDir: string): Promise<LoadedPack> {
  const manifestPath = join(packDir, 'pack.json');
  const manifestRaw = await readFileIfExists(manifestPath);
  if (manifestRaw === null) {
    throw new Error(`Pack directory "${packDir}" is missing pack.json`);
  }
  const manifest = parsePackManifest(manifestRaw, manifestPath);

  const skills = [];
  for (const ref of manifest.skills ?? []) {
    const loaded = await loadFileByRef(packDir, 'skills', ref);
    if (!loaded) {
      throw new Error(`Pack "${manifest.name}": skill file "${ref}" not found under ${packDir}/skills/`);
    }
    skills.push(parseSkillMd(loaded.content));
  }

  const routines = [];
  for (const ref of manifest.routines ?? []) {
    const loaded = await loadFileByRef(packDir, 'routines', ref);
    if (!loaded) {
      throw new Error(`Pack "${manifest.name}": routine file "${ref}" not found under ${packDir}/routines/`);
    }
    routines.push(parseRoutineMd(loaded.content));
  }

  const policies = [];
  for (const ref of manifest.policies ?? []) {
    const loaded = await loadFileByRef(packDir, 'policies', ref);
    if (!loaded) {
      throw new Error(`Pack "${manifest.name}": policy file "${ref}" not found under ${packDir}/policies/`);
    }
    // Basename without extension becomes the policy "name" for display.
    const name = ref.replace(/\.(md|markdown)$/i, '').split(/[/\\]/).pop()!;
    policies.push({ name, body: loaded.content.trim() });
  }

  return { manifest, dir: packDir, skills, routines, policies };
}

/**
 * List pack names available in a given directory. Used by the CLI's
 * `list-packs` command to surface both bundled and user-installed
 * packs. Returns manifests so callers can display the description
 * alongside the name.
 */
export async function listPacksInDir(dir: string): Promise<PackManifest[]> {
  if (!existsSync(dir)) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const manifests: PackManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(dir, entry.name, 'pack.json');
    const raw = await readFileIfExists(manifestPath);
    if (raw === null) continue;
    try {
      manifests.push(parsePackManifest(raw, manifestPath));
    } catch {
      // Skip invalid packs silently in list output — errors surface
      // when the user tries to install / create them.
    }
  }
  return manifests;
}
