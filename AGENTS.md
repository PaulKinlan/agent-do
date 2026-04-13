# agent-do — Development Guide

## What This Is

A standalone, provider-agnostic autonomous agent loop for JavaScript. Built on the Vercel AI SDK. Zero internal dependencies beyond `ai` and `zod`.

## Project Structure

```
src/
  agent.ts          — createAgent() — the main entry point
  loop.ts           — runAgentLoop / streamAgentLoop — core loop implementation
  types.ts          — all TypeScript interfaces and types
  stores.ts         — MemoryStore + FileEntry interfaces
  stores/
    in-memory.ts    — InMemoryMemoryStore (testing/prototyping)
    filesystem.ts   — FilesystemMemoryStore (Node.js persistent)
  tools/
    file-tools.ts   — createFileTools() — file tools backed by MemoryStore
  skills.ts         — skill system (parse, build prompt, InMemorySkillStore)
  permissions.ts    — permission evaluation logic
  usage.ts          — UsageTracker + cost estimation + DEFAULT_PRICING
  orchestrator.ts   — multi-agent orchestration (master + workers)
  testing/
    index.ts        — createMockModel() for testing
  eval/
    index.ts        — eval framework exports
    types.ts        — eval types (assertions, cases, results)
    assertions.ts   — assertion evaluators (13 types)
    runner.ts       — eval runner (defineEval, runEvals)
  index.ts          — all exports

tests/              — vitest unit tests (one file per module)
examples/           — focused single-feature examples (npx tsx examples/NN-name.ts)
demos/              — comprehensive end-to-end demo applications
  assistant/        — interactive CLI assistant with persistent memory
  research-team/    — multi-agent research pipeline (master + workers)
  code-reviewer/    — automated code review (read-only filesystem)
```

## Rules for Every Change

1. **Tests first** — write or update tests for every change. Run `npm test` before committing.
2. **Examples** — if the change affects user-facing API, update the relevant example in `examples/`.
3. **Demos** — if the change affects core API, verify all demos in `demos/` still work. Demos use `"agent-do": "file:../../"` so they always use the local version.
4. **README** — keep the README API reference table and examples table current.
5. **Types** — export all public types from `src/types.ts` and re-export from `src/index.ts`.
6. **No internal dependencies** — this package must NOT reference any private/internal packages. It is standalone.
7. **llms.txt** — update `llms.txt` if you add new exports or change the API surface.

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
