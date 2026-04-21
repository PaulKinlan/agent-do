/**
 * Template Packs (#78) — installable compositions of roles, skills,
 * routines, policies, tools, and MCP server bindings.
 *
 * Public surface:
 *
 *   - `createTemplatePack(name, options)` — build a ready-to-run
 *     agent from a pack.
 *   - `installPack(name, options)` / `uninstallPack(name, options)`
 *     / `listPacks(options)` — manage user-installed packs.
 *   - `loadPack(name, options)` — lower-level: parse the pack files
 *     without composing an agent.
 *   - `parsePackManifest` / `PackManifestSchema` — validate a raw
 *     `pack.json` body against the manifest schema.
 *
 * Pack directory layout (on disk):
 *
 *   my-pack/
 *     pack.json
 *     policies/*.md     (concatenated into system prompt)
 *     skills/*.md       (SKILL.md-style, installed into a SkillStore)
 *     routines/*.md     (installed into a RoutineStore)
 *     README.md         (shown by `list-packs`)
 */

export { createTemplatePack } from './create.js';
export {
  installPack,
  uninstallPack,
  listPacks,
  readInstallRegistry,
} from './install.js';
export {
  loadPack,
  loadPackFromDir,
  resolvePackDir,
  findBundledPacksDir,
  listPacksInDir,
} from './loader.js';
export { parsePackManifest, PackManifestSchema } from './manifest.js';
export type {
  PackManifest,
  PackVariable,
  LoadedPack,
  CreateTemplatePackOptions,
  TemplatePack,
} from './types.js';
export type {
  InstallPackOptions,
  UninstallPackOptions,
  ListPacksOptions,
  PackListEntry,
  InstalledPackEntry,
  InstallRegistry,
} from './install.js';
