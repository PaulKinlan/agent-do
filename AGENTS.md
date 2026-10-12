# agent-do — Development Guide

## What This Is

A standalone, provider-agnostic autonomous agent loop for JavaScript. Built on the Vercel AI SDK. Zero internal dependencies beyond `ai` and `zod`.

## Project Structure

```
src/
  agent.ts            — createAgent() — the main entry point
  loop.ts             — runAgentLoop / streamAgentLoop — core loop implementation
  loop-history.ts     — conversation-history hygiene for the loop (#33)
  cache.ts            — Anthropic prompt-cache breakpoints + isAnthropicModel (split from loop.ts)
  debug.ts            — per-run debug surface: middleware install + system-prompt/cache events
  tools-build.ts      — tool permission wrapping + buildTools() (split from loop.ts)
  types.ts            — all TypeScript interfaces and types
  index.ts            — all exports

  stores.ts           — MemoryStore + FileEntry + SearchOptions interfaces
  stores/
    in-memory.ts      — InMemoryMemoryStore (testing/prototyping)
    filesystem.ts     — FilesystemMemoryStore (Node.js persistent)
    sandbox.ts        — SandboxBackedMemoryStore (adapts a SandboxApi)
    file-lock.ts      — opt-in cross-process file locking (#15 Tier 1)
    agent-id.ts       — shared agentId validation
    search-matcher.ts — shared line matcher for store search()

  tools/
    file-tools.ts     — createFileTools() — internal primitive (not exported)
    workspace-tools.ts — createWorkspaceTools() — project files + deny list
    memory-tools.ts   — createMemoryTools() — the agent's private scratchpad
    shell-tool.ts     — createShellTool() — SandboxApi.exec as one tool
    deny-list.ts      — path-scoped access policy for file tools
    content-guards.ts — guards applied before tool data flows back to the model
    types.ts          — ToolResult (structured tool results, #48)

  sandbox/
    types.ts          — SandboxApi contract (#3)
    connectors/       — host passthrough + vercel-labs/just-bash

  skills.ts           — skill system (parse, build prompt, InMemorySkillStore)
  policies.ts         — typed system-prompt modules (#80)
  routines.ts         — named prompt-as-macro procedures (#77)
  slash-commands.ts   — deterministic pre-model dispatch (#76)
  scheduled-tasks.ts  — cron-driven agent runs with lock-file concurrency (#79)
  mcp.ts              — mount external MCP tool servers
  permissions.ts      — permission evaluation logic
  usage.ts            — UsageTracker + cost estimation + DEFAULT_PRICING
  orchestrator.ts     — multi-agent orchestration (master + workers)
  debug-middleware.ts — debug/observability middleware (#72)

  prompts/            — composable system prompts (builder, sections, templates)
  testing/
    index.ts          — createMockModel() for testing
  eval/
    index.ts          — eval framework exports
    types.ts          — eval types (assertions, cases, results)
    assertions.ts     — assertion evaluators (13 types)
    runner.ts         — eval runner (defineEval, runEvals)

  cli.ts              — CLI entry point (npx agent-do)
  cli/
    args.ts           — argument parser + stdin reader
    prompt.ts         — prompt mode (one-shot + interactive)
    script.ts         — script mode (npx agent-do run)
    eval-cmd.ts       — eval mode (npx agent-do eval)
    shellm.ts         — prompt files as executable scripts (#16)
    scheduled-tasks-cmd.ts — `agent-do scheduled-tasks` (#79)
    agents.ts         — create / list / load saved agent configs
    resolve-model.ts  — dynamic provider/model resolution + DEFAULT_MODELS
    provider-tools.ts — `--provider-tool` registry (provider-native tools)
    permission-handler.ts — interactive permission prompts (#17)
    debug-config.ts   — `--log-level` → AgentConfig.debug (#72)
    render.ts         — shared ProgressEvent rendering
    warnings.ts       — startup "no sandbox" warning

tests/              — vitest unit tests (one file per module)
  gates.test.ts     — the gates' own suite (fail-loud, markers, the generated map's truth)
  coverage-contract.json — GENERATED changed path -> suites for the FLEET's coverage extractor
examples/           — focused single-feature examples (npx tsx examples/NN-name.ts)
evals/              — eval suites: behaviour.ts (mock tier, CI) + quality.live.ts
docs/               — api-reference.md, sandbox.md, supply-chain.md, speed.md, guides/
demos/              — comprehensive end-to-end demo applications (npm workspaces, rule 12)
  assistant/        — interactive CLI assistant with persistent memory
  research-team/    — multi-agent research pipeline (master + workers)
  code-reviewer/    — automated code review (read-only filesystem)
  chief-of-staff/   — multi-agent scheduling / triage assistant
  engineering-team/ — multi-agent engineering workflow
tools/              — the gates (docs/speed.md)
  gate.conf         — the three commands the gates run: STATIC_CMD, FAST_GATE_RUNNER, FULL_TIER_CMD
  fast-gate.sh      — the implementer's gate: static check + the affected suites, fails loudly
  full-gate.sh      — the merger's gate: static check + every suite + the mock-tier evals
  suite-map.tsv     — changed path -> suites; GENERATED by gen-suite-map.mjs, never hand-edited
  gen-suite-map.mjs — derives that map (+ tests/coverage-contract.json) from the test import graph
  check.conf        — installed as ~/.fleet/check.conf by install-gate.sh (fleet-check sources that)
  install-gate.sh   — installs the two gate commands onto this VM
```

Keep this tree accurate — it is the first thing an agent reads before
touching the repo, and a stale map costs more than it saves.

## Rules for Every Change

1. **Tests first** — write or update tests for every change. Run `npm test` before committing.
2. **Examples** — if the change affects user-facing API, update the relevant example in `examples/`.
3. **Demos** — if the change affects core API, verify all demos in `demos/` still work. Demos use `"agent-do": "file:../../"` so they always use the local version, which makes them the only check that exercises the *published export surface* the way a real consumer does. CI runs a credential-free smoke (`Demo smoke (no credentials)`): every demo must reach its "No provider API key found" check. **If you remove or rename an export, grep `demos/` before you assume nothing uses it** — every demo silently broke on `createFileTools` for months because nothing ran them. Run it locally with `npm run demos:smoke`.
4. **README** — keep the README API reference table and examples table current.
5. **Types** — export all public types from `src/types.ts` and re-export from `src/index.ts`.
6. **No internal dependencies** — this package must NOT reference any private/internal packages. It is standalone.
7. **llms.txt** — update `llms.txt` if you add new exports or change the API surface.
8. **Model IDs and pricing** — `DEFAULT_MODELS` (`src/cli/resolve-model.ts`)
   and `DEFAULT_PRICING` (`src/usage.ts`) are a pair. Every CLI default
   must have a pricing entry, or that provider ships with cost tracking
   and the `perRunLimit` / `perDayLimit` guards silently disabled;
   `tests/usage.test.ts` asserts this. Take prices from the provider's own
   published pricing page and cite it in a comment — never from memory.
9. **`AGENTS.md` and `CLAUDE.md` are byte-identical mirrors.** Edit one,
   copy it over the other. CI fails the build if they diverge.
10. **Changing a dependency? Regenerate the lockfile from scratch.**

    ```bash
    rm -rf node_modules package-lock.json && npm install
    ```

    Never commit a lockfile produced by an incremental command
    (`npm install <pkg>`, `npm update`, `npm install --package-lock-only`).
    Those prune nested optional platform bindings that npm doesn't need
    on *your* machine but does need when resolving the full tree.

    **Do not check this by counting `@emnapi` entries.** Up to rolldown
    1.2.1 the pruned entries were `@rolldown/binding-wasm32-wasi`'s pinned
    `@emnapi/core`/`@emnapi/runtime`, and 11-vs-6 was a usable proxy;
    rolldown has since dropped that wasm binding, so a correct lockfile on
    this repo now has **zero** `@emnapi` entries and the count reads a
    healthy lockfile as broken. Check the property instead — every
    `dependencies` / `optionalDependencies` entry declared by any package
    in the lockfile must resolve to an entry in that same lockfile, and
    `npm ci --dry-run` must resolve the whole graph
    (`docs/supply-chain.md` § Lockfile regeneration has both commands).

    **A passing local `npm ci` does not catch a pruned lockfile** — it
    succeeds because your platform doesn't need those bindings. CI does,
    so every job dies at `Install` with
    `npm error Missing: … from lock file`. This has broken `main` twice.
    There is exactly ONE lockfile now — the root one
    (rule 12) — so there are no demo lockfiles to re-sync: regenerate the
    root with `rm -rf node_modules package-lock.json && npm install` and
    run `npm run demos:smoke` to confirm the demos still start.
    (An incremental `npm install <pkg>` can also rewrite SIBLING spec
    ranges in `package.json` — it silently lowers this repo's `@ai-sdk`
    dependency floors to the `peerDependencies` range
    (`agent-do-fn3`) — so check `git diff package.json` afterwards too.)
11. **Changesets** — see below.
12. **One lockfile, and the demos are npm workspaces.** `demos/*` are
    workspace members of the root package (`"workspaces": ["demos/*"]`), so
    a single root `package-lock.json` covers the library and all five demos.
    **Never add a `package-lock.json` under `demos/`** and never run
    `npm install` inside a demo: five independent demo lockfiles were the
    repo's top landing-collision hotspot (20+ recent commits), and removing
    them is the whole point. A dependency change means regenerating the root
    lockfile from scratch (rule 10) and then `npm run demos:smoke`.
    **In a worktree hydrated by `fleet-deps`, run `npm install` once at the
    root before you run, edit or debug a demo.** fleet-deps builds its store
    entry with `npm ci` in a directory holding only `package.json` + the
    lockfile, so npm never sees `demos/` and creates neither the member links
    nor the root self-link (`node_modules/agent-do -> ..`) that the demos
    import the library through; the store entry has no `agent-do` at all.
    `npm run demos:smoke` repairs that one link itself, but a hand-run
    (`cd demos/assistant && npm start`) needs the real install.

## Changesets (release discipline)

This repo uses [Changesets](https://github.com/changesets/changesets)
for version management. Releases are **cut manually** via
`npm run release` (see `scripts/release.sh`). There is no automated
publish workflow because the maintainer doesn't want a long-lived
`NPM_TOKEN` in CI.

### When to add a changeset

**Every change that affects what ships to npm consumers needs a
changeset.** That covers:

- Anything touching `src/` (runtime behaviour, types, new exports, bug
  fixes, refactors that change output).
- New `package.json` `files`/`exports`/`bin` entries.
- Dependency version bumps that consumers will see in their lockfile
  (anything in `dependencies` or `peerDependencies`).
- README changes that correct a documented API (the README ships in
  the tarball).

Skip the changeset when the change is **not** shipped:

- `tests/`, `examples/`, `demos/` — not in the `files` allowlist.
- `.github/`, `docs/`, `AGENTS.md`, `CLAUDE.md` — dev-only metadata.
- `scripts/`, `.changeset/config.json`, `vitest.config.ts` — tooling.
- `devDependencies` bumps — consumers don't see these.

If you're unsure whether a change is user-facing: add a changeset. An
extra `patch` entry in the CHANGELOG is cheap; a missed feature is
not.

### How to add one

```bash
npm run changeset
```

Pick the bump level following the pre-1.0 rule of thumb:

- **patch** — bug fixes, internal refactors that don't change behaviour,
  error-message tweaks, doc-on-public-API corrections.
- **minor** — new features, non-breaking API additions, security fixes
  (even breaking ones, while we're pre-1.0).
- **major** — reserved for the 1.0 cut. Pre-1.0, breaking changes ride
  in **minor**.

Write the body as a short user-facing changelog entry (not "refactored
loop.ts", but "`streamAgentLoop` now yields a new `step-complete`
event"). It lands verbatim in `CHANGELOG.md` at release time.

Commit the `.changeset/*.md` file in the **same commit or PR as the
code change** — never separately — so history and CHANGELOG stay
aligned.

### Commit message format

Not required. Changesets determines the bump from `.changeset/*.md`,
not from commit prefixes, so `feat:`/`fix:`/`chore:` are optional.
Write commits however makes the history readable.

## Demos vs Examples

| | examples/ | demos/ |
|---|---|---|
| Purpose | Learn one feature | See everything together |
| Size | 30-80 lines | 100-300+ lines |
| Interactivity | Runs and exits | Interactive / multi-turn |
| Persistence | Usually in-memory | Filesystem-backed |
| Complexity | Single agent, few tools | Multi-agent, hooks, skills, history |
| Own package.json | No | Yes — `"agent-do": "file:../../"` |

Demos import from `'agent-do'` (not relative paths) but resolve to the local copy via the `file:` dependency. This means:
- Imports look exactly like what a published user would write
- Changes to src/ are immediately reflected in demos
- No version drift between demos and library

## Running Tests

```bash
npm test                    # run all tests
npx vitest run --watch      # watch mode
npx vitest run tests/loop.test.ts  # single file
```

## Gates (`fleet-check`) — read `docs/speed.md` first

This repo is tiered, and the tiers are the contract (`docs/speed.md`, `~/fleet/docs/speed.md`):

| gate | command | who runs it | budget |
|---|---|---|---|
| **fast** | `bash tools/fast-gate.sh` (`fleet-check --fast`) | implementer lanes, while iterating | ≤ 60 s |
| **full** | `bash tools/full-gate.sh` (`fleet-check`) | the **merger**, once per landing union | ≤ 300 s |

- **Never run the full gate from a work lane.** `fleet-check` refuses a non-merger lane by design (R13); a
  full run a lane starts is a landing the merger cannot do. `fleet-check --full` is the explicit override.
- **While iterating, run only the affected tests:** `npx vitest run tests/<file>.test.ts`, or
  `bash tools/fast-gate.sh --changed src/<module>.ts`. Commit, then `fleet-check --fast`; end the turn and
  wait for the `[check]` message rather than polling.
- **The fast gate selects from `tools/suite-map.tsv`, which is GENERATED.** Do not hand-edit it. If your
  change makes a module reach a new suite, run `node tools/gen-suite-map.mjs` and commit the map with the
  change. `tests/gates.test.ts` fails if the map is stale, if it names a suite that does not exist, or if
  `src/` has a module with neither a map row nor a recorded reason. The same command also writes
  `tests/coverage-contract.json`, which is how the fleet's own coverage extractor maps a changed file to its
  suites — commit both together or the cached verdict will call your files unmapped.
- **A changed file that maps to no suite is a LOUD failure, not a no-op** (`fast-gate: unmapped:`, exit 1).
  That is deliberate (fleet-1n0z): a gate that runs nothing still exits 0 and looks green. The fix is the
  suite, or an exemption with a reason on the line — never silence.
- **A dependency, lockfile or `vitest.config.ts` change is not a fast-tier change.** Those are deliberately
  unmapped: they can reach every suite, so the fast gate refuses them and the full gate pays. Say so on the
  bead when you need `fleet-check --full`.
- **Tests must be independent** — no order dependence, no machine state, no other lane's files, no
  wall-clock bounds. Use `mkdtemp` for anything on disk; never write under `$HOME` or a fixed `/tmp` path.
  Those three pathologies are defects in the suite, not flakiness (`docs/speed.md` §6).
- **Installing the gates on a VM:** `bash tools/install-gate.sh` copies `tools/check.conf` to
  `~/.fleet/check.conf`, which `fleet-check` sources (it is machine-global, one project per VM).

## Running Examples

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npx tsx examples/01-basic-agent.ts
npx tsx examples/11-filesystem-store.ts
```

## Running Demos

The demos are npm workspaces: **one install at the repo root**, no per-demo install.

```bash
npm install                                   # once, at the repo root: covers the library and every demo
export ANTHROPIC_API_KEY=sk-ant-...           # or a Google/OpenAI key; see demos/README.md
npm start -w agent-do-demo-assistant          # run one demo from the root
npm run demos:smoke                           # the credential-free check CI runs (no key needed)
```

`npm start -w <workspace>` runs the demo with its own directory as the working directory, so
`demos/assistant/.data/` and friends stay inside the demo. `(cd demos/assistant && npm start)` works too.

## Testing Strategy

### Unit Tests (tests/)
Test individual functions and classes in isolation using `createMockModel()`:
- Mock model returns predetermined responses — no API calls
- Test tool execution, hook behavior, permission logic, usage tracking
- Test store implementations (read/write/delete round-trips)

### Integration Tests
Use `createMockModel()` with multi-step response sequences to test:
- Full agent loop execution (tool call → result → text)
- Conversation history passed correctly
- Hooks firing in the right order
- Permission system blocking/allowing correctly

### Eval Framework (agent-do/eval)
For evaluating agent quality (not just correctness):
- `defineEval()` + `runEvals()` for structured eval suites
- 13 assertion types: contains, not-contains, regex, json-schema, tool-called, tool-not-called, tool-args, file-exists, file-contains, max-steps, max-cost, llm-rubric, custom
- Multi-provider comparison via `options.providers`
- LLM-as-judge via `llm-rubric` assertion
- Output formats: console, json, csv, silent
- Each case gets isolated memory store

## Key Design Decisions

- **MemoryStore is agentId-scoped** — every method takes `agentId` as the first parameter. This allows one store instance to serve multiple agents.
- **The loop is a generator** — `streamAgentLoop` is an `AsyncGenerator<ProgressEvent>`. This is consumed by `agent.stream()` and by callers iterating with `for await`.
- **Hooks are optional async functions** — they can return `HookDecision` to allow/deny/stop/modify. All hooks are fire-and-forget safe (errors logged, not thrown).
- **The mock model uses a response queue** — `responses[0]` for the first LLM call, `responses[1]` for the second, etc. This makes tests deterministic.
- **Prompt caching is automatic** — `prepareStep` adds Anthropic cache control breakpoints. No configuration needed.
- **HTML generation order** — the system prompt instructs: DOM first, CSS second, JS third.
- **FilesystemMemoryStore safety** — supports `readOnly` mode and `onBeforeWrite` callback. The callback receives canonicalized paths (../ resolved before the callback fires).

## What NOT to Do

- Do not add browser-specific code (no `chrome.*`, no DOM, no `window`)
- Do not import from any private/internal monorepo packages
- Do not add heavy dependencies — keep the bundle small
- Do not use `eval()` or `Function()` in production code
- Do not modify the mock model to have side effects in tests
- Do not let demos use relative imports — always import from `'agent-do'`
