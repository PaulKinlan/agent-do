---
"agent-do": patch
---

Document the Node 20+ runtime requirement via `package.json` `engines` (npm emits a clean `EBADENGINE` instead of a confusing ESM/`node:` failure on older runtimes). README examples table now lists the MCP (14) and routines (15) examples that were missing. `docs/supply-chain.md` zod row corrected to `^4.4.3` (it still read `^3.23.0` through 0.6.0).
