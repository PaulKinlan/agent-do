---
"agent-do": minor
---

Template packs — installable compositions of skills, routines, policies, tool groups, and MCP server bindings.

- New `createTemplatePack(name, options)` API composes a ready-to-run agent from a bundled or user-installed pack. It interpolates `{{variable}}` placeholders in the system prompt, policies, skills, and routines; installs skills into a `SkillStore`; saves routines into a `RoutineStore`; wires the declared tool groups and MCP servers; and returns the composed `Agent` plus metadata.
- New CLI subcommands: `npx agent-do install <pack>`, `npx agent-do uninstall <pack>`, `npx agent-do list-packs`. Install copies the pack into `.agent-do/packs/<name>/` and records it in `.agent-do/packs/config.json`; `--force` overwrites; `--from <dir>` installs a local pack directory (useful while authoring).
- New programmatic APIs: `installPack`, `uninstallPack`, `listPacks`, `readInstallRegistry`, `loadPack`, `loadPackFromDir`, `resolvePackDir`, `parsePackManifest`, `PackManifestSchema`, plus the corresponding types (`PackManifest`, `PackVariable`, `LoadedPack`, `CreateTemplatePackOptions`, `TemplatePack`, `PackListEntry`, `InstalledPackEntry`, `InstallRegistry`).
- Three packs ship bundled: `chief-of-staff` (full — policies, skills, routines, docs), `engineering-team` (sprint-ordered pipeline skills), `research-team` (scout / analyst / synthesiser / fact-checker).
- `packs/` is added to the npm `files` allowlist so bundled packs ship with the published tarball.
