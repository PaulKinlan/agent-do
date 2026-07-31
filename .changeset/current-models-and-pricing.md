---
"agent-do": minor
---

Bring model IDs and pricing up to the current generation.

`DEFAULT_PRICING` gains the current Claude models — `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4-8`, `claude-fable-5`, `claude-mythos-5` — and the full Z.ai GLM family (`glm-5.2` through `glm-4.5`, rates from Z.ai's published pricing). The GLM entries close a gap from the `zai` provider's introduction: `glm-4.6` is the CLI default for `--provider zai` but had no pricing entry, so every zai run silently ran with cost tracking and both spending limits disabled. Legacy entries are unchanged, so existing model IDs keep their rates.

The Anthropic CLI default moves from `claude-sonnet-4-6` to `claude-sonnet-5` — same price tier, current generation. If you pin a model with `--model` or `AgentConfig.model`, nothing changes. `DEFAULT_MODELS` is now exported from `src/cli/resolve-model.ts` (internal path, not a public entry point) so tests can assert that every CLI default has a pricing entry.

Examples, demos, and the README move to `claude-sonnet-5` / `claude-opus-5`; `npx agent-do --help` now lists `zai` among the providers and names the per-provider default models.
