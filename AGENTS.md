# agent-do — Development Guide

## What This Is

A standalone, provider-agnostic autonomous agent loop for JavaScript. Built on the Vercel AI SDK. Zero internal dependencies beyond `ai` and `zod`.

## Project Structure

```
src/
  agent.ts            — createAgent() — the main entry point
  loop.ts             — runAgentLoop / streamAgentLoop — core loop implementation
  loop-history.ts     — conversation-history hygiene for the loop (#33)
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
examples/           — focused single-feature examples (npx tsx examples/NN-name.ts)
evals/              — eval suites: behaviour.ts (mock tier, CI) + quality.live.ts
docs/               — api-reference.md, sandbox.md, supply-chain.md, guides/
demos/              — comprehensive end-to-end demo applications
  assistant/        — interactive CLI assistant with persistent memory
  research-team/    — multi-agent research pipeline (master + workers)
  code-reviewer/    — automated code review (read-only filesystem)
  chief-of-staff/   — multi-agent scheduling / triage assistant
  engineering-team/ — multi-agent engineering workflow
```

Keep this tree accurate — it is the first thing an agent reads before
touching the repo, and a stale map costs more than it saves.

## Rules for Every Change

1. **Tests first** — write or update tests for every change. Run `npm test` before committing.
2. **Examples** — if the change affects user-facing API, update the relevant example in `examples/`.
3. **Demos** — if the change affects core API, verify all demos in `demos/` still work. Demos use `"agent-do": "file:../../"` so they always use the local version, which makes them the only check that exercises the *published export surface* the way a real consumer does. CI runs a credential-free smoke (`Demo smoke (no credentials)`): every demo must reach its "No provider API key found" check. **If you remove or rename an export, grep `demos/` before you assume nothing uses it** — every demo silently broke on `createFileTools` for months because nothing ran them.
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
    on *your* machine but does need when resolving the full tree — for
    this repo, `@rolldown/binding-wasm32-wasi`'s pinned
    `@emnapi/core`/`@emnapi/runtime`. A full regeneration writes 11
    `@emnapi` entries; an incremental one writes 6.

    **A passing local `npm ci` does not catch this** — it succeeds on the
    pruned lockfile because your platform doesn't need those bindings. CI
    does need them, so every job dies at `Install` with
    `npm error Missing: @emnapi/core@… from lock file`. This has broken
    `main` twice. Also re-run `npm install` in each `demos/*` afterwards
    so the demo lockfiles stay in sync for the demo CI job.
11. **Changesets** — see below.

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

## Running Examples

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npx tsx examples/01-basic-agent.ts
npx tsx examples/11-filesystem-store.ts
```

## Running Demos

```bash
export ANTHROPIC_API_KEY=sk-ant-...
(cd demos/assistant && npm install && npm start)
(cd demos/research-team && npm install && npm start)
(cd demos/code-reviewer && npm install && npm start)
```

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
