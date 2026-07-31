---
"agent-do": patch
---

Fix `estimateCost` resolving dated model IDs to the wrong pricing entry. Model IDs that aren't an exact key fall back to prefix matching, which previously took the *first* prefix in table order rather than the most specific one. `gpt-4.1-mini-2025-04-14` was billed at `gpt-4.1` rates (5× over), `gemini-2.5-flash-lite-preview-09-2025` at `gemini-2.5-flash` rates (5.6× over), and `o3-mini-*` at `o3` rates. Because `usage.limits.perRun` / `perDay` are enforced against these estimates, affected runs could abort well before the real spend reached the limit.

Lookups now take the longest matching key, so a dated or suffixed variant always resolves to the most specific entry. Exact matches are unaffected, and the rule applies to custom `usage.pricing` tables too.
