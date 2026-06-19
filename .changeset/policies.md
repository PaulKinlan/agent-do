---
"agent-do": minor
---

Add a `Policy` primitive — typed system-prompt modules that ground every decision on every turn (GitHub #80). `AgentConfig.policies: Policy[]` injects a well-marked `## Policies` section into the system prompt, with each policy wrapped in `<policy id="…" type="…">…</policy>` markers that carry the same injection-safety preamble skills use (a hostile body containing `</policy>` cannot break out of its wrapper). `createPolicy({ id, type, content })` or `createPolicy({ id, type, source })` builds a policy from an object or a POLICY.md source with YAML frontmatter; `parsePolicyMd()` and `buildPoliciesPrompt()` handle parsing/rendering. `InMemoryPolicyStore` + the `PolicyStore` interface support callers who load policies from disk (no `url`/network field, mirroring `SkillSearchResult`). There is no LLM-facing install tool — policies are operator-authored, since a model rewriting its own policy would be a persistent jailbreak.
