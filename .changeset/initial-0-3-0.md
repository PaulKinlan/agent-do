---
"agent-do": minor
---

Security, reliability, and tooling overhaul. Several CLI and library defaults changed — see below for migration notes.

### Security

- **[C-01]** CLI no longer hard-codes `permissions: { mode: 'accept-all' }`. The default now asks for confirmation on destructive tools (`write_file`, `edit_file`, `delete_file`, `memory_write`, `memory_delete`) in TTY mode and denies them in non-TTY mode. Pass `--accept-all` (alias `--yes`/`-y`) or `--allow <tools>` to opt back into the old behaviour for scripted pipelines.
- **[C-03]** `agent-do run <arg>` no longer silently imports local JS/TS files. Saved-agent names resolve via the saved-agent lookup only; to run a script path use `npx agent-do run ./agent.ts --script`. The flag adds an interactive confirmation with path/size/SHA-256 (`-y`/`--yes` skips the prompt in TTY, required in non-TTY).
- **[H-02 / M-02]** `grep_file` and `memory_search` default to literal substring matching (case-insensitive). Pass `{ regex: true }` to opt into regex mode; patterns go through a catastrophic-backtracking guard before compilation.
- **[H-03]** `loadSavedAgent` validates JSON via a strict Zod schema. Planted agent files are rejected with a stderr diagnostic rather than silently loaded.
- **[H-05]** `install_skill` is no longer exposed to the LLM by default. Set `AgentConfig.allowSkillInstall: true` to expose it. Skill bodies are wrapped in `<skill>` markers with a preamble; `</skill>` sequences in skill content are neutralised so a hostile skill can't break out of the isolation block.
- **[M-03]** New `AgentConfig.toolLimits` with `maxToolCalls` / `maxToolCallsPerIteration` for bounding runaway tool-call fan-out.
- **[M-07]** Spending cap is now checked after every model step via `onStepFinish`, not just between outer iterations. `AgentConfig.usage.hardLimitMultiplier` (default 1.25) configures the per-step hard cap as a multiple of `perRun`.
- **[#20 / #22 / #30]** `FilesystemMemoryStore` path resolution hardened: canonical-to-canonical containment check, per-agent isolation (a1 can't touch a2's files via `../`), root-path-safe `withinBase`, async `realpath` on the hot path.
- **[#39 / #40 / #41]** Provider SDKs pinned exactly in `dependencies` (kept as `^3.0.0` in `peerDependencies`); runtime import-shape check via `typeof mod[factory] === 'function'`; documented `@vercel/oidc` transitive dep in `docs/supply-chain.md`.

### Reliability

- **[M-01]** `FilesystemMemoryStore` methods migrated to `node:fs/promises`; `list()` uses a bounded concurrency pool for stat calls.
- **[L-01]** Stale `<tool_output>` bodies are redacted from conversation history between iterations (configurable via `AgentConfig.historyKeepWindow`, default 1).
- **[#21 / #26]** Workspace file tools now cap read / write / grep-line sizes and sanitise filesystem errors before they reach the model.

### Observability (#48)

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
