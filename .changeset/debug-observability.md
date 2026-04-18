---
"agent-do": minor
---

Deeper observability: middleware-level debug hooks + CLI log levels (closes #72).

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
