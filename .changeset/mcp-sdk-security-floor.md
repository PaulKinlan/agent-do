---
"agent-do": patch
---

Raise the `@modelcontextprotocol/sdk` floor to `^1.30.0`. 1.29.x pulled in `hono`, `@hono/node-server`, and `fast-uri` versions carrying published advisories (one high: `fast-uri` host confusion); 1.30.0 clears all of them. Dependencies are also refreshed within their existing ranges (`ai` 6.0.238, `@ai-sdk/*` 3.0.9x–3.0.104).

One transitive advisory remains and is deliberately not overridden: `@ai-sdk/provider-utils` hard-pins `undici@^5.29.0`, which is below the `6.24.0` fix line. `docs/supply-chain.md` records the reachability analysis and the override to apply if your threat model requires it.
