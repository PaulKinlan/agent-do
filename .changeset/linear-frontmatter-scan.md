---
'agent-do': minor
---

Frontmatter splitting in `parseSkillMd` and `parseRoutineMd` is now a linear line scan instead of a
backtracking regex. The `^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$` shape parses in polynomial time on a
hostile document — a run of whitespace-only lines after the opening `---` with no closing fence is the
pathological case — so a crafted `SKILL.md` or routine file could burn CPU in the regex engine while being
parsed. Both call sites now use an O(n) scan that reproduces the old matching behaviour, including the
whitespace-only lines the old `\s*\n` skipped and the full `\s` set it accepted before a fence's newline.
The scan also follows the old regex in refusing to close on a fence that would leave the frontmatter empty when a
later fence exists, so `---\n\n---\nname: x\ndescription: y\n---\nbody` still parses that metadata (the second
fence is YAML's own document marker) instead of treating it as an empty block and pushing `name: x` into the
body. Two differences remain. The first one is observable and is a body change: for a document whose only fences
are adjacent or blank-line separated (`---\n---\nrest`, `---\n\n---\nrest`) the scanner reports an empty
frontmatter and `rest` as the body, where the old skills/routines regex matched nothing and callers kept the
whole document — fence lines included — as the body. That only affects a document which is nothing but an empty
metadata block plus content, and nothing was in that block to lose, but such a body no longer starts with those
fence lines; `parsePolicyMd` and `.shellm` files already behaved the scanner's way. The second difference is not
observable: frontmatter that is *entirely* whitespace comes back as an empty string rather than as that
whitespace, and every caller parses the frontmatter as YAML, where both are "no metadata".

The scanner was already present as two private copies in `src/policies.ts` and `src/cli/shellm.ts`; it is now
a single shared module (`src/frontmatter.ts`) used by all four callers, so the control lives in one place.
No public API change: `parseSkillMd` / `parseRoutineMd` keep their signatures, and every caller YAML-parses
the frontmatter and trims the body as before.
