# Chief of Staff demo

Founder's chief of staff pattern ([inspired by clawchief](https://github.com/snarktank/clawchief)), built on agent-do's orchestrator. Master agent coordinates three specialists — Executive Assistant, Business Development, Task Manager — against a shared workspace of markdown files.

## What it shows

- **Policy-as-markdown**: `priority-map.md` + `auto-resolver.md` get re-read at the start of every run and ground every decision. Orthogonal policy files (priorities vs resolution modes) so each can evolve independently.
- **Source-of-truth rule**: no resolving from memory alone; specialists always check the current state of `inbox.md` / `tracker.md` / `tasks.md` before acting.
- **Silence contract**: if there's nothing to do, the master responds with `OK` and calls no tools — cheap to run on a cron.
- **Role-handoff pattern**: each specialist has a narrow brief and defers to the others when a signal isn't theirs.

## Setup

```sh
# Set an API key for any supported provider:
export ANTHROPIC_API_KEY=sk-ant-...            # Anthropic (default)
# export GOOGLE_GENERATIVE_AI_API_KEY=...      # Google / Gemini
# export OPENAI_API_KEY=sk-...                 # OpenAI

npm install
npm start
# Or with an explicit instruction:
npm start "Triage the inbox and add follow-ups to tasks.md"
```

First run seeds `./sandbox/` with mock `inbox.md`, `tracker.md`, `tasks.md` plus the two policy files.

This demo auto-detects the provider from whichever API key is set. To force a specific provider when multiple keys are present, set `DEMO_PROVIDER=anthropic|google|openai`. See [demos/README.md](../README.md#choose-a-model-provider) for the full env surface.

## What's mocked vs real

- **Inbox / tracker / tasks** — markdown files in `sandbox/`. In production you'd replace `inbox.md` with a Gmail MCP mount (`mcp__gmail__list_messages`, `mcp__gmail__get_message`). The pattern is identical; only the tool surface changes.
- **Scheduling** — in production the EA worker would get a Calendar MCP (`mcp__calendar__list_events`, `mcp__calendar__suggest_time`).

## Structure

```
index.ts        — master + 3 workers wired to one shared FilesystemMemoryStore
sandbox/        — created on first run
  priority-map.md
  auto-resolver.md
  inbox.md
  tracker.md
  tasks.md
```

All four roles (master + 3 specialists) bind their file tools with
`agentId: ''` — the workspace-root mode documented in
`src/stores/agent-id.ts`. That's why every specialist reads/writes
directly in `sandbox/` rather than a per-agent subdirectory
(`sandbox/master/`, `sandbox/executive-assistant/`, …). This is a
single shared workspace by design — the orthogonal-policy pattern
(`priority-map.md` / `auto-resolver.md`) only works if every role
sees the same files.

## Extensions (what the pack abstraction would bundle)

When #78 (template packs) lands, this shape becomes:

```ts
await createTemplatePack('chief-of-staff', {
  owner: 'Paul Kinlan',
  mcpServers: { gmail: {...}, calendar: {...} },
});
```

…and the pack manifest codifies: the three role prompts, the two policy files, the shared workspace layout, and the cron schedule for a scheduled inbox sweep.
