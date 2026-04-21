/**
 * Pack install / uninstall / listing (#78).
 *
 * Install target: `.agent-do/packs/<name>/` in the caller's project.
 * A sibling `.agent-do/packs/config.json` records what's installed so
 * upgrades and uninstalls are traceable:
 *
 *   {
 *     "installedPacks": {
 *       "chief-of-staff": {
 *         "version": "1.0.0",
 *         "installedAt": "2026-04-21T12:00:00.000Z",
 *         "source": "bundled"
 *       }
 *     }
 *   }
 *
 * Pack installation is a straight copy of the pack directory. We don't
 * execute anything from the pack at install time — packs are data,
 * not code. The copy is bounded in size + entry count, skips symlinks
 * and dotfiles, and validates the manifest first.
 */

import { promises as fs, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  findBundledPacksDir,
  listPacksInDir,
  loadPackFromDir,
  resolvePackDir,
} from './loader.js';
import type { PackManifest } from './types.js';

const USER_PACKS_SUBDIR = join('.agent-do', 'packs');
const INSTALL_REGISTRY_FILE = 'config.json';

/** Max total bytes we'll copy for a single pack. Generous for text-only packs. */
const MAX_PACK_BYTES = 4 * 1024 * 1024;
/** Max entries (files + dirs) per pack. */
const MAX_PACK_ENTRIES = 512;
/** Max depth inside a pack directory. */
const MAX_PACK_DEPTH = 8;

export interface InstalledPackEntry {
  version: string;
  installedAt: string;
  /** Where the pack came from — `'bundled'` or `'<path>'` for a --from path. */
  source: string;
}

export interface InstallRegistry {
  installedPacks: Record<string, InstalledPackEntry>;
}

function registryPath(cwd: string): string {
  return resolve(cwd, USER_PACKS_SUBDIR, INSTALL_REGISTRY_FILE);
}

function userPacksDir(cwd: string): string {
  return resolve(cwd, USER_PACKS_SUBDIR);
}

/**
 * Load the install registry. Missing file → empty registry. Malformed
 * file → warn on stderr and start fresh; we don't want a corrupt
 * registry to wedge installs.
 */
export async function readInstallRegistry(cwd: string = process.cwd()): Promise<InstallRegistry> {
  const path = registryPath(cwd);
  try {
    const raw = await fs.readFile(path, 'utf8');
    // JSON reviver drops prototype-pollution keys defensively.
    const parsed = JSON.parse(raw, (key, value) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        return undefined;
      }
      return value;
    }) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as InstallRegistry).installedPacks === 'object' &&
      (parsed as InstallRegistry).installedPacks !== null
    ) {
      return parsed as InstallRegistry;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(
        `[agent-do] Ignoring malformed pack registry at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }
  return { installedPacks: Object.create(null) };
}

async function writeInstallRegistry(
  registry: InstallRegistry,
  cwd: string,
): Promise<void> {
  const path = registryPath(cwd);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

/**
 * Copy a pack directory tree from `src` to `dest`. Refuses symlinks
 * (we don't want an install to follow attacker-controlled links out
 * of the pack dir) and caps total bytes / entries / depth to bound
 * the blast radius of a hostile or malformed pack. Skips dotfiles —
 * pack content is all visible-named markdown / JSON.
 */
async function copyPackTree(src: string, dest: string): Promise<void> {
  let byteCount = 0;
  let entryCount = 0;

  async function walk(srcDir: string, destDir: string, depth: number): Promise<void> {
    if (depth > MAX_PACK_DEPTH) {
      throw new Error(`Pack directory tree deeper than ${MAX_PACK_DEPTH} levels — refusing to install.`);
    }
    await fs.mkdir(destDir, { recursive: true });
    const entries = await fs.readdir(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // skip hidden files / dot-dirs
      entryCount++;
      if (entryCount > MAX_PACK_ENTRIES) {
        throw new Error(`Pack has more than ${MAX_PACK_ENTRIES} entries — refusing to install.`);
      }
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Pack contains a symlink at ${join(srcDir, entry.name)} — refusing to install. Packs must not include symlinks.`,
        );
      }
      const srcPath = join(srcDir, entry.name);
      const destPath = join(destDir, entry.name);
      if (entry.isDirectory()) {
        await walk(srcPath, destPath, depth + 1);
      } else if (entry.isFile()) {
        const stat = await fs.stat(srcPath);
        byteCount += stat.size;
        if (byteCount > MAX_PACK_BYTES) {
          throw new Error(`Pack exceeds ${MAX_PACK_BYTES} bytes — refusing to install.`);
        }
        await fs.copyFile(srcPath, destPath);
      }
      // Other entry types (sockets, block devices, …) are silently skipped.
    }
  }

  await walk(src, dest, 0);
}

/**
 * Validate that `dest` is actually inside the user-packs root. Defence
 * in depth: the pack name regex in the manifest schema already blocks
 * `../` segments, but an explicit check here means a future bug can't
 * let a crafted name escape the sandbox.
 */
function assertWithinPacksRoot(packsRoot: string, dest: string): void {
  const relPath = relative(packsRoot, dest);
  if (relPath.startsWith('..') || relPath.startsWith(`..${sep}`) || resolve(packsRoot, relPath) !== dest) {
    throw new Error(`Install destination "${dest}" escapes packs root "${packsRoot}".`);
  }
}

export interface InstallPackOptions {
  /** Directory to install into. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Source directory to copy from. When omitted, installs the bundled
   * pack with matching name. When provided, copies from this directory
   * (which must itself contain a `pack.json`).
   */
  from?: string;
  /** Overwrite an existing installation of the same name. */
  force?: boolean;
}

/**
 * Install a pack into the caller's project.
 *
 * Returns the installed manifest. Throws if the pack can't be found,
 * already exists (without `force`), or violates copy-safety rules.
 */
export async function installPack(
  name: string,
  options: InstallPackOptions = {},
): Promise<PackManifest> {
  const cwd = options.cwd ?? process.cwd();
  let src: string | null;
  let sourceLabel: string;
  if (options.from) {
    src = resolve(cwd, options.from);
    sourceLabel = src;
    if (!existsSync(src)) {
      throw new Error(`--from source "${src}" does not exist.`);
    }
  } else {
    const bundled = findBundledPacksDir();
    if (!bundled) {
      throw new Error('Bundled packs directory not found. Run `agent-do install <pack> --from <path>` to install from an explicit location.');
    }
    src = resolvePackDir(name, { packsDir: bundled, cwd });
    sourceLabel = 'bundled';
    if (!src) {
      throw new Error(
        `Bundled pack "${name}" not found. Run \`agent-do list-packs\` to see available packs.`,
      );
    }
  }

  // Validate the manifest at the source before copying anything.
  const loaded = await loadPackFromDir(src);
  if (loaded.manifest.name !== name) {
    throw new Error(
      `Pack name mismatch: install requested "${name}" but the manifest at ${src}/pack.json declares "${loaded.manifest.name}".`,
    );
  }

  const packsRoot = userPacksDir(cwd);
  const dest = join(packsRoot, name);
  assertWithinPacksRoot(packsRoot, dest);

  const alreadyExists = existsSync(dest);
  if (alreadyExists && !options.force) {
    throw new Error(
      `Pack "${name}" is already installed at ${dest}. Pass --force to overwrite.`,
    );
  }
  if (alreadyExists) {
    await fs.rm(dest, { recursive: true, force: true });
  }

  await copyPackTree(src, dest);

  const registry = await readInstallRegistry(cwd);
  registry.installedPacks[name] = {
    version: loaded.manifest.version,
    installedAt: new Date().toISOString(),
    source: sourceLabel,
  };
  await writeInstallRegistry(registry, cwd);

  return loaded.manifest;
}

export interface UninstallPackOptions {
  cwd?: string;
}

/**
 * Remove an installed pack. Returns true if something was removed,
 * false if the pack wasn't installed to begin with (so callers can
 * print a useful message without errors).
 */
export async function uninstallPack(
  name: string,
  options: UninstallPackOptions = {},
): Promise<boolean> {
  const cwd = options.cwd ?? process.cwd();
  const packsRoot = userPacksDir(cwd);
  const dest = join(packsRoot, name);
  assertWithinPacksRoot(packsRoot, dest);

  const existsOnDisk = existsSync(dest);
  const registry = await readInstallRegistry(cwd);
  const inRegistry = Object.prototype.hasOwnProperty.call(registry.installedPacks, name);

  if (existsOnDisk) {
    await fs.rm(dest, { recursive: true, force: true });
  }
  if (inRegistry) {
    delete registry.installedPacks[name];
    await writeInstallRegistry(registry, cwd);
  }
  return existsOnDisk || inRegistry;
}

export interface ListPacksOptions {
  cwd?: string;
}

export interface PackListEntry {
  manifest: PackManifest;
  /** Where this pack lives. */
  source: 'bundled' | 'user';
  /** Absolute directory the pack is in. */
  dir: string;
  /** True when the same name also exists in the other source. */
  shadowed?: boolean;
}

/**
 * List packs visible to the caller — both bundled (shipped with the
 * library) and user-installed (in `.agent-do/packs/`). When a name
 * appears in both, both entries are returned and the user-installed
 * entry is marked as shadowing the bundled one.
 */
export async function listPacks(options: ListPacksOptions = {}): Promise<PackListEntry[]> {
  const cwd = options.cwd ?? process.cwd();
  const entries: PackListEntry[] = [];

  const bundledDir = findBundledPacksDir();
  const bundledManifests = bundledDir ? await listPacksInDir(bundledDir) : [];
  for (const m of bundledManifests) {
    entries.push({
      manifest: m,
      source: 'bundled',
      dir: join(bundledDir!, m.name),
    });
  }

  const userDir = userPacksDir(cwd);
  const userManifests = await listPacksInDir(userDir);
  const userNames = new Set(userManifests.map((m) => m.name));
  for (const m of userManifests) {
    entries.push({
      manifest: m,
      source: 'user',
      dir: join(userDir, m.name),
      shadowed: false,
    });
  }
  for (const e of entries) {
    if (e.source === 'bundled' && userNames.has(e.manifest.name)) {
      e.shadowed = true;
    }
  }
  return entries;
}
