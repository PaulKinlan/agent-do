# Supply chain notes

A short, maintained record of decisions about agent-do's dependency
graph. If you're auditing a release before deploying it somewhere
sensitive, this is the file to read.

## Direct dependencies

Ranges below mirror `package.json`. **If you change a range, change this
table in the same commit** — it drifted through 0.6.0 (it described the
provider SDKs as exact pins long after they had moved to caret ranges).

| Package | Range | Why |
|---|---|---|
| `@ai-sdk/anthropic` | `^3.0.85` | Bundled provider so `npx agent-do` works without a separate install. Also declared as an optional `peerDependency` (`^3.0.85`) for library consumers who supply their own. |
| `@ai-sdk/google` | `^3.0.67` | Same as above. |
| `@ai-sdk/openai` | `^3.0.0` | Same as above. Also backs the `ollama` and `zai` providers via their OpenAI-compatible endpoints, so it is the least removable of the three. |
| `@modelcontextprotocol/sdk` | `^1.30.0` | MCP client for `mountMcpServers()`. Floor raised from `^1.29.0` for the transitive `hono` / `@hono/node-server` / `fast-uri` advisories that 1.30.0 clears. |
| `ai` | `^6.0.208` | Vercel AI SDK core. Wide range because the SDK is the source of truth for the provider versions above; pinning would just delay upgrades. |
| `ignore` | `^7.0.5` | gitignore-style matcher for the workspace deny list (#23). Tiny, no transitive deps. |
| `yaml` | `^2.9.0` | Skill frontmatter parser (#37). Maintained by `eemeli`; well-audited. |
| `zod` | `^4.4.3` | Schema validation. Peer-of-peer with the AI SDK. |

The provider SDKs sit in both `dependencies` (so the CLI is
self-contained) and optional `peerDependencies` (so a library consumer
can supply a newer minor without a duplicate install). `tryImport`
loads them dynamically, so a consumer who never touches a given
provider never pays for it.

### Pending major upgrades

`ai@7` and `@ai-sdk/*@4` are released and we are deliberately still on
`ai@6` / `@ai-sdk/*@3`. The `LanguageModel` type from `ai` is part of
agent-do's **public** surface (`AgentConfig.model`), so the upgrade
changes the contract for every consumer that constructs its own model —
it needs its own branch, its own changeset, and a compatibility pass
over `src/loop.ts`, `src/cli/provider-tools.ts`, and the demos. Do not
fold it into an unrelated change.

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

### `undici` (5.29.0) — known-vulnerable, deliberately not overridden

Comes in via `ai`/`@ai-sdk/*` → `@ai-sdk/provider-utils`, which declares
`undici: ^5.29.0` as a hard dependency. `npm audit` reports several
advisories against `undici < 6.24.0` (one high: unbounded memory in
WebSocket `permessage-deflate` decompression; plus request smuggling,
CRLF injection via the `upgrade` option, and an unbounded decompression
chain on fetch responses).

- **Why it's there:** `@ai-sdk/provider-utils` lazily `require()`s
  `undici` to build a "safe" Node fetch — an `Agent` with a
  DNS-lookup hook that blocks SSRF to private address ranges. It is
  loaded only when `globalThis.fetch` is Node's built-in fetch, which
  means it **is** on the live path for provider HTTP calls.
- **Exposure:** the reachable advisory for agent-do's usage is the
  fetch-response decompression chain. Exploiting it requires the model
  provider's own endpoint — or a MITM on a TLS connection to it — to
  return a hostile `Content-Encoding` chain. The WebSocket advisories
  are not reachable; agent-do opens no WebSockets through undici.
- **Why we don't `overrides` it:** forcing `undici@^6` violates the
  `^5.29.0` range `@ai-sdk/provider-utils` was built and tested
  against, on every consumer of agent-do, to close an advisory we
  cannot reach without a compromised provider endpoint. The fix
  belongs upstream in `@ai-sdk/provider-utils`.
- **If your threat model needs it anyway**, add to *your* app's
  `package.json` (not agent-do's) and test provider calls end to end:

  ```json
  { "overrides": { "undici": "^6.24.0" } }
  ```

Re-check on every `@ai-sdk/*` bump; drop this section once upstream
moves off undici 5.

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
npm ls undici         # still pinned by @ai-sdk/provider-utils?
npm run typecheck && npm run build && npm test
```

If `npm ls @vercel/oidc` shows a new ancestry path or the package
disappears, update the table above accordingly. `npm audit` is not
expected to come back clean while the `undici` section above stands —
compare the output against the accepted advisories listed there and
investigate anything new.
