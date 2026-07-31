---
"agent-do": minor
---

Move the OpenAI and Google CLI defaults to current models. `--provider openai` defaults to `gpt-5.6-terra` (was `gpt-4.1-mini`) and `--provider google` to `gemini-3.6-flash` (was `gemini-2.5-flash`). Each provider's default is now its current balanced tier — the same reasoning that puts Anthropic on Sonnet rather than Haiku or Opus. Pinning a model with `--model` or `AgentConfig.model` is unaffected.

`DEFAULT_PRICING` gains the GPT-5.6 tiers — `gpt-5.6-sol` ($5/$30), `gpt-5.6-terra` ($2/$12), `gpt-5.6-luna` ($0.20/$1.20), and the bare `gpt-5.6` alias that routes to Sol — plus `gemini-3.6-flash`, `gemini-3.5-flash`, and `gemini-3.5-flash-lite`. Rates come from OpenAI's and Google's published pricing pages. Note that Gemini bills long-context prompts (>200k tokens) at a higher rate that this table cannot express; it carries the standard rate and will under-report on very large prompts.

Examples, demos, and the README move off `gpt-5.4` and the preview Gemini IDs.
