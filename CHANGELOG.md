# agent-do

## 0.4.0

### Minor Changes

- [#73](https://github.com/PaulKinlan/agent-do/pull/73) [`7caffa4`](https://github.com/PaulKinlan/agent-do/commit/7caffa444dcc77e4fbe89f3c50306c38a48a947c) Thanks [@PaulKinlan](https://github.com/PaulKinlan)! - Deeper observability: middleware-level debug hooks + CLI log levels (closes [#72](https://github.com/PaulKinlan/agent-do/issues/72)).

  New `AgentConfig.debug` surfaces a layer below `--verbose`:

  - **`system-prompt`** — the resolved prompt, emitted once per run.
  - **`messages`** — the full message list before each `streamText` call.
  - **`request`** — model id, tool names, provider options.
  - **`response-part`** — raw stream parts (partType always; full payload at `trace` level).
  - **`cache`** — per-step `cacheReadTokens` / `cacheWriteTokens` / `noCacheTokens` / `outputTokens`, so you can tell whether Anthropic prompt caching is firing.

  The CLI gains `--log-level silent | info | verbose | debug | trace`. `--verbose` / `--show-content` stay as aliases. New channels render as labelled single-line entries on stderr (`[debug:cache] step=1 read=1198 write=0 no-cache=14 out=87 hit=98%`).

  Library callers pass a `debug: DebugConfig` option with per-channel flags plus an optional `sink` for routing events in addition to the existing progress stream. Events flow as `type: 'debug'` progress events so consumers that iterate `agent.stream()` see them without new plumbing.

  Wired via `wrapLanguageModel` from the AI SDK for `messages` / `request` / `response-part`, and via the existing `onStepFinish` hook for `cache`. Zero overhead when `debug` is undefined (default).

  Passing a string model id (e.g. `model: 'claude-sonnet-4-6'`) skips middleware-dependent channels because the SDK resolves providers lazily from strings; `system-prompt` and `cache` still fire.

- [#82](https://github.com/PaulKinlan/agent-do/pull/82) [`cbe3bef`](https://github.com/PaulKinlan/agent-do/commit/cbe3bef426e6c2135016d68dca3166e27f3678f2) Thanks [@PaulKinlan](https://github.com/PaulKinlan)! - MCP (Model Context Protocol) server mounting (closes [#75](https://github.com/PaulKinlan/agent-do/issues/75)).

  agent-do can now mount external MCP servers and expose their tools to the model alongside local tools. Three transports supported: stdio (subprocess), SSE (legacy HTTP long-polling), and streamable HTTP.

  New `AgentConfig.mcpServers` option:

  ```ts
  const agent = createAgent({
    model,
    mcpServers: [
      {
        name: "fs",
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        },
        allowedTools: ["read_text_file", "list_directory"],
      },
      {
        name: "search",
        transport: { type: "http", url: "https://example.com/mcp" },
      },
    ],
  });
  ```

  ### Design

  - **Tool namespacing** — discovered tools are renamed `mcp__<server>__<tool>` so two servers exposing a same-named tool don't collide. `namespacedToolName()` exported for use in logs / debug output.
  - **Lifecycle handled by the loop** — `runAgentLoop` and `streamAgentLoop` mount servers before starting and close them in a `finally` block. Subprocesses don't leak on abort/error/completion.
  - **All-or-nothing mount** — if any server fails to connect, previously-connected servers are closed before the error propagates. No half-mounted state.
  - **Optional `allowedTools` filter** — expose only a subset of a server's tools to the model. Useful when a server offers many tools but the agent needs a couple.
  - **Permissions + hooks apply uniformly** — MCP tools go through the same `wrapToolWithPermissions` path as local tools, so `onPreToolUse` / `onPostToolUse` fire for them, permissions gate them, and `toolLimits` count them.
  - **Content flattening** — MCP tool responses can be mixed content (text, images, embedded resources). Today we flatten to concatenated text with short descriptors for non-text parts (`[image: image/png]`, `[resource: <uri>]`).

  ### New exports

  - `mountMcpServers(configs)` → `{ tools, toolOrigins, close }` — standalone mounting helper for callers who don't want the loop's lifecycle management.
  - `namespacedToolName(server, tool)` — build the namespaced name without duplicating the `mcp__` convention.
  - `MCP_TOOL_PREFIX = 'mcp__'` — the stable prefix constant.
  - Types: `McpServerConfig`, `McpTransportConfig`, `MountedMcpServers`.

  ### Dependencies

  Adds `@modelcontextprotocol/sdk` as a runtime dependency.

  Example: see `examples/14-mcp.ts` — mounts the filesystem reference server against a sandbox directory.

- [#83](https://github.com/PaulKinlan/agent-do/pull/83) [`d4eade5`](https://github.com/PaulKinlan/agent-do/commit/d4eade53a696e8379fdff30c6007edf4abd81f75) Thanks [@PaulKinlan](https://github.com/PaulKinlan)! - Saved Routines: prompt-as-macro primitive (closes [#77](https://github.com/PaulKinlan/agent-do/issues/77)).

  A routine is a named, reusable procedure — "like a bash script but it's a prompt." Routines are distinct from skills:

  |                  | Skill                            | Routine                                      |
  | ---------------- | -------------------------------- | -------------------------------------------- |
  | Purpose          | Instructions on when/how to do X | Named saved procedure                        |
  | Triggering       | Autonomous, description-matched  | **Explicit by name**, optionally with args   |
  | Grows over time? | Hand-written                     | **Accumulates** — runCount + lastRun tracked |

  ### New exports

  - `AgentConfig.routines` — any `RoutineStore`
  - `AgentConfig.allowRoutineSave` — privileged flag to expose the `save_routine` tool (default false, same threat model as `allowSkillInstall`)
  - `InMemoryRoutineStore`, `FilesystemRoutineStore`
  - `parseRoutineMd(content, id?)` — markdown + YAML frontmatter parser
  - `interpolateRoutine(body, args)` — `{{name}}` placeholder substitution
  - `createRoutineTools(store, { allowSave })` — produces the tool set below
  - Types: `Routine`, `RoutineStore`, `RoutineInput`

  ### Tools exposed to the model

  Always:

  - `list_routines` — id / name / description / runCount per routine
  - `run_routine(routineId, args?)` — retrieve a routine, interpolate `{{arg}}` placeholders, return the body wrapped in `<routine>` markers for the model to follow. Bumps runCount + lastRun.

  Gated behind `allowRoutineSave: true`:

  - `save_routine` — persist a new routine. Same validation surface as `install_skill`.

  ### Storage

  `FilesystemRoutineStore` stores each routine as `<rootDir>/<id>.md` with YAML frontmatter + body. Run metadata (runCount, lastRun) lives in a single `.runs.json` sidecar so routine files don't get rewritten on every invocation.

  ### Body interpolation

  Bodies may contain `{{name}}` placeholders that get filled from the `args` object passed to `run_routine`. Unknown placeholders are left in place — the model can see which args it still needs.

  Deliberately minimal: no conditionals, loops, or expressions. Routines are prompts, not DSLs.

  ### Example

  See `examples/15-routines.ts` — pre-saves two routines (`triage-inbox`, `weekly-report`), then the agent runs one with an argument. `runCount` persists across runs.

- [#81](https://github.com/PaulKinlan/agent-do/pull/81) [`8934b69`](https://github.com/PaulKinlan/agent-do/commit/8934b69ccb9eb562e62ffb1e606a83c37b036883) Thanks [@PaulKinlan](https://github.com/PaulKinlan)! - Two-tier skill loading: manifest mode + `load_skill(id)` tool (closes [#74](https://github.com/PaulKinlan/agent-do/issues/74)).

  agent-do is provider-agnostic, so we can't rely on any model's trained behaviour around skill discovery — the lookup flow has to be explicit in the prompt and tool surface. Three additions make that happen:

  - **`AgentConfig.skillsMode`** — `'full'` (pre-[#74](https://github.com/PaulKinlan/agent-do/issues/74) behaviour, every body inlined), `'manifest'` (compact id/name/description/triggers only), or `'auto'` (default — flips to manifest once the combined bodies exceed `skillsManifestThreshold`, default 32 KB).
  - **`load_skill(id)` tool** — automatically added by `createSkillTools`. Returns the full skill body wrapped in `<skill>` markers, so the model can retrieve a skill on demand instead of scanning an ever-growing system prompt.
  - **"How to Use Skills" system-prompt section** — appended whenever skills are present, explicitly tells the model to scan the manifest / apply the inline skill before starting a sub-task.

  Skill frontmatter now supports a `triggers:` array of verbatim user phrases. Entries are validated individually (bad ones dropped, not the whole list) and capped at 32. `InMemorySkillStore.search()` matches against triggers, so the substring-search fallback picks up how users actually phrase requests — not just how authors name skills.

  Manifest-mode entries are wrapped in `<skill-manifest-entry>` markers with the same injection-safety escapes as `<skill>` bodies (`escapeSkillManifestBody`).

  New exports: `resolveSkillsMode`, `buildSkillUsageInstruction`, `SkillsPromptMode`, `BuildSkillsPromptOptions`.

  Backwards compatible: if you don't set `skillsMode`, agent-do auto-picks. Small skill sets stay in full mode and behave identically to before. Existing `buildSkillsPrompt(skills)` calls default to `mode: 'full'`.

## 0.3.0

### Minor Changes

- [#71](https://github.com/PaulKinlan/agent-do/pull/71) [`929d28a`](https://github.com/PaulKinlan/agent-do/commit/929d28a410d32c2e78b8d6e9f0a3f9ac3985f62e) Thanks [@PaulKinlan](https://github.com/PaulKinlan)! - Security, reliability, and tooling overhaul. Several CLI and library defaults changed — see below for migration notes.

  ### Security

  - **[C-01]** CLI no longer hard-codes `permissions: { mode: 'accept-all' }`. The default now asks for confirmation on destructive tools (`write_file`, `edit_file`, `delete_file`, `memory_write`, `memory_delete`) in TTY mode and denies them in non-TTY mode. Pass `--accept-all` (alias `--yes`/`-y`) or `--allow <tools>` to opt back into the old behaviour for scripted pipelines.
  - **[C-03]** `agent-do run <arg>` no longer silently imports local JS/TS files. Saved-agent names resolve via the saved-agent lookup only; to run a script path use `npx agent-do run ./agent.ts --script`. The flag adds an interactive confirmation with path/size/SHA-256 (`-y`/`--yes` skips the prompt in TTY, required in non-TTY).
  - **[H-02 / M-02]** `grep_file` and `memory_search` default to literal substring matching (case-insensitive). Pass `{ regex: true }` to opt into regex mode; patterns go through a catastrophic-backtracking guard before compilation.
  - **[H-03]** `loadSavedAgent` validates JSON via a strict Zod schema. Planted agent files are rejected with a stderr diagnostic rather than silently loaded.
  - **[H-05]** `install_skill` is no longer exposed to the LLM by default. Set `AgentConfig.allowSkillInstall: true` to expose it. Skill bodies are wrapped in `<skill>` markers with a preamble; `</skill>` sequences in skill content are neutralised so a hostile skill can't break out of the isolation block.
  - **[M-03]** New `AgentConfig.toolLimits` with `maxToolCalls` / `maxToolCallsPerIteration` for bounding runaway tool-call fan-out.
  - **[M-07]** Spending cap is now checked after every model step via `onStepFinish`, not just between outer iterations. `AgentConfig.usage.hardLimitMultiplier` (default 1.25) configures the per-step hard cap as a multiple of `perRun`.
  - **[[#20](https://github.com/PaulKinlan/agent-do/issues/20) / [#22](https://github.com/PaulKinlan/agent-do/issues/22) / [#30](https://github.com/PaulKinlan/agent-do/issues/30)]** `FilesystemMemoryStore` path resolution hardened: canonical-to-canonical containment check, per-agent isolation (a1 can't touch a2's files via `../`), root-path-safe `withinBase`, async `realpath` on the hot path.
  - **[[#39](https://github.com/PaulKinlan/agent-do/issues/39) / [#40](https://github.com/PaulKinlan/agent-do/issues/40) / [#41](https://github.com/PaulKinlan/agent-do/issues/41)]** Provider SDKs pinned exactly in `dependencies` (kept as `^3.0.0` in `peerDependencies`); runtime import-shape check via `typeof mod[factory] === 'function'`; documented `@vercel/oidc` transitive dep in `docs/supply-chain.md`.

  ### Reliability

  - **[M-01]** `FilesystemMemoryStore` methods migrated to `node:fs/promises`; `list()` uses a bounded concurrency pool for stat calls.
  - **[L-01]** Stale `<tool_output>` bodies are redacted from conversation history between iterations (configurable via `AgentConfig.historyKeepWindow`, default 1).
  - **[[#21](https://github.com/PaulKinlan/agent-do/issues/21) / [#26](https://github.com/PaulKinlan/agent-do/issues/26)]** Workspace file tools now cap read / write / grep-line sizes and sanitise filesystem errors before they reach the model.

  ### Observability ([#48](https://github.com/PaulKinlan/agent-do/issues/48))

  - `tool-result` progress events now carry a structured `userSummary` (operator-facing) and `data` (programmatic consumers) alongside the existing model-facing content. Full tool results are opt-in via `AgentConfig.emitFullResult`.

  ### Minor changes

  - `[L-02]` `SkillSearchResult` no longer exposes `url` (SSRF footgun).
  - `[L-03]` API-key preflight errors now name the expected env var.
  - `[L-05]` Skill-file frontmatter parsing uses the `yaml` package.
  - `[L-06]` `estimateCost` warns once per unknown model instead of silently returning 0.
  - `[M-04]` Anthropic-model detection tightened to avoid false positives on unrelated vendors.

  ### Tooling

  - GitHub Actions CI matrix across Node 20 / 22 / 24.
  - `vitest.config.ts` restricts test discovery to `tests/**/*.test.ts` (vitest 4 widened the default glob).
  - `tsconfig.json` sets `types: ["node"]` for TS 6 + `moduleResolution: bundler` compatibility.
  - Changesets configured for version management and publishing (`npm run changeset` to record a change, version PRs opened automatically by the release workflow).

  ### Dependencies

  - `zod` bumped to `^4.3.6` (was `^3.23.0`). Project schemas are compatible with the v4 API without code changes.
  - `vitest` to `^4.1.4`, `typescript` to `^6.0.3`, `ai` to `^6.0.168`.
