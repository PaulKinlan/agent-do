# Supply chain notes

A short, maintained record of decisions about agent-do's dependency
graph. If you're auditing a release before deploying it somewhere
sensitive, this is the file to read.

## Direct dependencies

| Package | Pinning | Why |
|---|---|---|
| `@ai-sdk/anthropic` | exact (`3.0.71`) | Bundled provider — pinned exact in `dependencies` so `npx agent-do` users get a deterministic install. The wider `^3.0.0` range stays in `peerDependencies` for library consumers. |
| `@ai-sdk/google` | exact (`3.0.64`) | Same as above. |
| `@ai-sdk/openai` | exact (`3.0.53`) | Same as above. |
| `ai` | `^6.0.0` | Vercel AI SDK core. We use a wide range because the SDK itself is the source of truth for the provider versions above; pinning would just delay upgrades. |
| `ignore` | `^7.0.5` | gitignore-style matcher for the workspace deny list (#23). Tiny, no transitive deps. |
| `yaml` | `^2.8.3` | Skill frontmatter parser (#37). Maintained by `eemeli`; well-audited. |
| `zod` | `^3.23.0` | Schema validation. Peer-of-peer with the AI SDK. |

The provider SDKs are pinned exactly in `dependencies` (so the CLI is
reproducible) but kept at `^3.0.0` in `peerDependencies` so library
consumers who want a newer minor can pass it in without conflict.
Each release bumps the pinned versions deliberately after manual
verification.

## Notable transitive dependencies

### `@vercel/oidc` (3.1.0)

Comes in via `ai → @ai-sdk/gateway → @vercel/oidc`. Surfaced by the
0.1.4 security audit (#41) because OIDC token handlers have access to
sensitive deployment-identity material.

- **Why it's there:** `@ai-sdk/gateway` uses it to fetch OIDC tokens
  for Vercel-hosted runtimes when calling Vercel's AI gateway.
- **Runtime impact for agent-do users:** none unless you're running
  inside Vercel and using the gateway path. agent-do itself never
  calls into the gateway; it talks to provider APIs directly.
- **Env vars to watch:** `VERCEL_OIDC_TOKEN`, `VERCEL_*`. If these are
  set in your environment for an unrelated reason, the package may
  read them. Audit your env before running agent-do in shared
  shells.
- **Removal:** not feasible — it's deep in the AI SDK's transitive
  graph and removing it would break the gateway code path. We can't
  use npm `overrides` to stub it without risking that path.

### Provider-validated dynamic import (#40)

`src/cli/resolve-model.ts` uses `await import()` to load the provider
SDK on demand. After the import resolves, we check that the expected
factory export (e.g. `createAnthropic`) is a function before invoking
it. This is an **export-surface sanity check**, not a tamper-proof
guard — by the time the check runs, the imported module's top-level
code has already executed. What it catches:

1. **Broken or substituted installs** where the imported package no
   longer exposes the expected factory export (renamed across a major
   version, partial install, bad lockfile resolution).
2. **Dependency-confusion / typosquat packages whose export shape does
   not match `@ai-sdk/foo`'s API.** A typosquat that perfectly mimics
   the SDK's public surface is *not* caught here — lockfile integrity
   and `npm audit` are the real defences against that.
3. **Future refactors that wire `--provider <pkg>` to user input** —
   the `tryImport` `pkg` parameter is typed as a literal union, so
   arbitrary strings are rejected at compile time and never reach
   `import()`.

The runtime check is deliberately minimal (`typeof === 'function'`)
because the SDK's full API shifts between minor versions and richer
validation would create false positives. A tampered or malicious
package that still exports the expected factory passes this check;
the real integrity story lives in the lockfile + `npm audit`
verification step below.

## Verifying a release

Before you publish a new version, run:

```bash
npm ci                # install from lockfile
npm audit             # CVE check
npm ls @vercel/oidc   # confirm ancestry hasn't changed
npm run typecheck && npm run build && npm test
```

If `npm ls @vercel/oidc` shows a new ancestry path or the package
disappears, update the table above accordingly.
