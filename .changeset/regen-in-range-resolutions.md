---
'agent-do': patch
---

Refresh the locked dependency resolutions to the newest versions the declared ranges allow. `package.json` is
unchanged: 65 packages move inside their existing ranges (`ai` 7.0.44 → 7.0.137, the `@ai-sdk/*` provider
packages, `@modelcontextprotocol/sdk`, `esbuild`, `hono`), none are added or removed, and the audit count
improves from 26 advisories (one of them critical) to 19, all in the dev-only `@changesets` toolchain.
Regenerating the lockfile from scratch used to fail the test suite; that was the test mock still being on the
retired V3 model spec, not anything in these packages.
