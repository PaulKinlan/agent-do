---
"agent-do": minor
---

Two-tier skill loading: manifest mode + `load_skill(id)` tool (closes #74).

agent-do is provider-agnostic, so we can't rely on any model's trained behaviour around skill discovery — the lookup flow has to be explicit in the prompt and tool surface. Three additions make that happen:

- **`AgentConfig.skillsMode`** — `'full'` (pre-#74 behaviour, every body inlined), `'manifest'` (compact id/name/description/triggers only), or `'auto'` (default — flips to manifest once the combined bodies exceed `skillsManifestThreshold`, default 32 KB).
- **`load_skill(id)` tool** — automatically added by `createSkillTools`. Returns the full skill body wrapped in `<skill>` markers, so the model can retrieve a skill on demand instead of scanning an ever-growing system prompt.
- **"How to Use Skills" system-prompt section** — appended whenever skills are present, explicitly tells the model to scan the manifest / apply the inline skill before starting a sub-task.

Skill frontmatter now supports a `triggers:` array of verbatim user phrases. Entries are validated individually (bad ones dropped, not the whole list) and capped at 32. `InMemorySkillStore.search()` matches against triggers, so the substring-search fallback picks up how users actually phrase requests — not just how authors name skills.

Manifest-mode entries are wrapped in `<skill-manifest-entry>` markers with the same injection-safety escapes as `<skill>` bodies (`escapeSkillManifestBody`).

New exports: `resolveSkillsMode`, `buildSkillUsageInstruction`, `SkillsPromptMode`, `BuildSkillsPromptOptions`.

Backwards compatible: if you don't set `skillsMode`, agent-do auto-picks. Small skill sets stay in full mode and behave identically to before. Existing `buildSkillsPrompt(skills)` calls default to `mode: 'full'`.
