---
'agent-do': minor
---

Frontmatter splitting in `parseSkillMd` and `parseRoutineMd` is now a linear line scan instead of a
backtracking regex. The `^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$` shape parses in polynomial time on a
hostile document — a run of whitespace-only lines after the opening `---` with no closing fence is the
pathological case — so a crafted `SKILL.md` or routine file could burn CPU in the regex engine while being
parsed. Both call sites now use an O(n) scan that reproduces the old matching behaviour, including the
whitespace-only lines the old `\s*\n` skipped and the full `\s` set it accepted before a fence's newline.
The only observable difference is that two adjacent fences (`---\n---\nrest`) now yield an empty frontmatter
and `rest` as the body, where the old skills/routines regex returned the whole document as the body (policies
and `.shellm` files already behaved the new way). A frontmatter block that is *entirely* whitespace also comes
back as an empty string rather than as that whitespace; since every caller YAML-parses the frontmatter, that
one is not observable.

The scanner was already present as two private copies in `src/policies.ts` and `src/cli/shellm.ts`; it is now
a single shared module (`src/frontmatter.ts`) used by all four callers, so the control lives in one place.
No public API change: `parseSkillMd` / `parseRoutineMd` keep their signatures, and every caller YAML-parses
the frontmatter and trims the body as before.
