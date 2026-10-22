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
| `@ai-sdk/anthropic` | `^4.0.25` | Bundled provider so `npx agent-do` works without a separate install. Also declared as an optional `peerDependency` (`^4.0.0`) for library consumers who supply their own. |
| `@ai-sdk/google` | `^4.0.29` | Same as above. |
| `@ai-sdk/openai` | `^4.0.25` | Same as above. Also backs the `ollama` and `zai` providers via their OpenAI-compatible endpoints, so it is the least removable of the three. |
| `@modelcontextprotocol/sdk` | `^1.30.0` | MCP client for `mountMcpServers()`. Floor raised from `^1.29.0` for the transitive `hono` / `@hono/node-server` / `fast-uri` advisories that 1.30.0 clears. |
| `ai` | `^7.0.44` | Vercel AI SDK core. Wide range because the SDK is the source of truth for the provider versions above; pinning would just delay upgrades. |
| `ignore` | `^7.0.5` | gitignore-style matcher for the workspace deny list (#23). Tiny, no transitive deps. |
| `yaml` | `^2.9.0` | Skill frontmatter parser (#37). Maintained by `eemeli`; well-audited. |
| `zod` | `^4.4.3` | Schema validation. Peer-of-peer with the AI SDK. |

The provider SDKs sit in both `dependencies` (so the CLI is
self-contained) and optional `peerDependencies` (so a library consumer
can supply a newer minor without a duplicate install). `tryImport`
loads them dynamically, so a consumer who never touches a given
provider never pays for it.

### Lockfile regeneration

Any dependency change must be followed by a **full** regeneration:

```bash
rm -rf node_modules package-lock.json && npm install
```

Incremental commands (`npm install <pkg>`, `npm update`,
`npm install --package-lock-only`) silently prune nested optional
platform bindings — the class of entry `npm ci` still validates from
another platform. **Do not check this by counting the `@emnapi`
entries.** Up to rolldown 1.2.1 the pruned entries were the
`@emnapi/core` / `@emnapi/runtime` copies pinned by
`@rolldown/binding-wasm32-wasi`, and 11-vs-6 was a usable proxy; rolldown
then dropped that wasm binding (1.2.8 declares fifteen optional bindings
and no wasm32 one), so a correct lockfile on this repo now has **zero**
`@emnapi` entries and the proxy reads a healthy lockfile as broken. Check
the property itself instead — every dependency and optionalDependency
that any package in the lockfile declares must resolve to an entry in
that same lockfile:

```bash
npm ci --dry-run        # the cheapest real check: npm validates the whole graph
node -e 'const p=require("./package-lock.json").packages;const have=new Set(Object.keys(p).filter(k=>k.includes("node_modules/")).map(k=>k.split("node_modules/").pop()));const miss=[];for(const [k,m] of Object.entries(p))for(const f of ["dependencies","optionalDependencies"])for(const d of Object.keys(m[f]||{}))if(!have.has(d))miss.push(d+" <- "+k);console.log(miss.length?miss:"ok: no declared dependency is missing from the lockfile")'
```

A lockfile that fails `npm ci --dry-run` while succeeding on your own
platform is the defect this rule exists for. Watch `git diff package.json`
as well: an incremental `npm install <pkg>` also rewrites SIBLING spec
ranges — it lowers this repo's `@ai-sdk` dependency floors to the
`peerDependencies` range (`agent-do-fn3`).

**If you need one specific version to investigate something, do not run a
plain `npm install <pkg>@<version>`** — that is the case that rewrites the
sibling specs above. Use

```bash
npm install <pkg>@<version> --no-save --no-package-lock --no-audit --no-fund
```

which leaves `package.json` and the lockfile exactly as they were. Its one
caveat: resolving outside the lockfile can nest a duplicate transitive that
the locked tree does not contain (this has been seen as
`node_modules/ai/node_modules/@ai-sdk/provider`), so afterwards repair the
tree with `rm -rf node_modules && fleet-deps`.

**If the sibling ranges have already moved**, do not commit the widened
spec: restore **just those range lines**. `git restore -p package.json`
(or `git checkout -p package.json`) lets you pick the hunks, and editing them
back by hand works too. Do *not* run a blanket `git checkout -- package.json`:
that also throws away any deliberate range change you have not committed yet,
which is a worse outcome than the trap you are undoing. Then regenerate the
lockfile from scratch per the rule above. A widened floor is
invisible to the test suite and only shows up later as a repo that accepts
dependency versions it never agreed to.

### Runtime floor

`engines.node` is `>=22`, inherited from AI SDK 7. Node 20 is no longer
supported and is not in the CI matrix. Bumping this is a consumer-visible
break — do it only alongside a dependency that forces it, and say so in
the changeset.

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

### `undici` (7.x) — resolved by the AI SDK 7 upgrade

`@ai-sdk/provider-utils` lazily `require()`s `undici` to build a "safe"
Node fetch — an `Agent` with a DNS-lookup hook that blocks SSRF to
private address ranges. It is loaded whenever `globalThis.fetch` is
Node's built-in fetch, so it **is** on the live path for provider HTTP
calls.

Under `ai@6`, `@ai-sdk/provider-utils@4` hard-pinned `undici@^5.29.0`,
below the `6.24.0` line that fixes a set of published advisories. We
declined to force an override, because that would have violated the
range upstream tested against on every consumer of agent-do.

`@ai-sdk/provider-utils@5` (shipped with `ai@7`) moved to
`undici@^7.28.0`, which is past the fix line — so the upgrade closed
this without an override.

That closes the **runtime** advisories, not every advisory in the repository. Two
commands, two answers — re-run both on every `@ai-sdk/*` bump and record the date
with the numbers, because they rot:

| command | result | what it means |
|---|---|---|
| `npm audit --omit=dev` | **0 vulnerabilities** | the published package resolves nothing with a known advisory. **This is the release gate.** |
| `npm audit` | **22 advisories, all dev-only** (16 high, 6 moderate, 0 critical) | dev tooling only: they arrive through three trees — `@changesets/cli` (the only direct release-tool one) and its dependants `braces`, `micromatch`, `fast-glob`, `globby`, `js-yaml`, `argparse`, `sprintf-js`, `@manypkg/get-packages`, `read-yaml-file`; the docs generator `typedoc` via `markdown-it` (GHSA-vfgh-jcmw-g37q, GHSA-gfr2-rv44-r23c); and the test runner `vitest` / `@vitest/mocker` (GHSA-qxg6-89mg-rqv8, GHSA-xp26-3454-mjgp) |

Both figures are measured on 2026-10-22. The dev-tree advisories are triaged as
**not shipped**: they live in the `@changesets/cli` release toolchain, the
`typedoc` docs generator, and the `vitest` test runner — none of which a
consumer of agent-do installs. The `markdown-it` and `vitest` roots have
in-range patch fixes available (`npm audit fix` plans markdown-it 14.3.3,
vitest/@vitest/mocker 4.1.12); only the `@changesets/cli` tree still requires
a semver-major bump (3.0.3), which is why these stay recorded here rather
than applied. An unqualified "`npm audit` is clean" was what made this paragraph
unverifiable — it read as the release gate and failed the moment a dev dependency
gained an advisory.

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
disappears, update the table above accordingly. `npm audit --omit=dev`
(the release gate) is expected to come back **clean** — investigate
anything it reports rather than accepting it as known noise. The full
`npm audit` returns the known dev-only advisories recorded above;
compare the counts against that table instead of expecting zero.
