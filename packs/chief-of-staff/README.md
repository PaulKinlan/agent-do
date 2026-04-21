# Chief of Staff pack

An opinionated composition of agent-do primitives that gives a principal
(founder, exec, solo operator) a working chief of staff: inbox triage, BD
follow-up, and daily task management against a shared markdown workspace.

Shaped after the clawchief pattern — policy modules injected into the system
prompt, deterministic handoffs, and a single source-of-truth workspace each
role reads before acting.

## What's inside

| Component   | Files |
|-------------|-------|
| Policies    | `priority-map.md`, `auto-resolver.md` (concatenated into the system prompt) |
| Skills      | `priority-triage`, `meeting-notes`, `follow-up-cadence` |
| Routines    | `daily-task-prep`, `nightly-backup` |
| Tools       | Workspace tools (`read_file`, `write_file`, …) rooted at the working directory |
| Variables   | `owner` (required), `timezone` (default `UTC`) |

## Install

```
npx agent-do install chief-of-staff
```

This copies the pack to `.agent-do/packs/chief-of-staff/` in your project so
you can edit the policies, skills, and routines in place — they're meant to
be customised.

## Use

```ts
import { createTemplatePack } from 'agent-do';
import { createAnthropic } from '@ai-sdk/anthropic';

const { agent } = await createTemplatePack('chief-of-staff', {
  model: createAnthropic()('claude-sonnet-4-6'),
  variables: { owner: 'Paul Kinlan', timezone: 'Europe/London' },
  workingDir: './workspace',
});

const report = await agent.run(
  'Do the morning pass: triage the inbox, update the BD tracker, refresh tasks.md.',
);
console.log(report);
```

The agent expects a workspace directory with these files (see
`demos/chief-of-staff` for a seeded example):

- `inbox.md` — mock inbox or whatever feeds it at runtime
- `tracker.md` — BD / CRM state
- `tasks.md` — the live TODO list
- `meetings/` — meeting note output (created as needed)
- `backups/` — nightly snapshots (created by the `nightly-backup` routine)

## MCP bindings

This pack does **not** require any MCP servers by default — everything runs
against the local filesystem. In production you'd usually mount Gmail and
Calendar servers and have the `priority-triage` / `meeting-notes` skills
read from them directly. To add them:

```ts
const { agent } = await createTemplatePack('chief-of-staff', {
  model,
  variables: { owner: 'Paul Kinlan' },
  mcpServers: {
    gmail: { name: 'gmail', transport: { type: 'stdio', command: 'gmail-mcp' } },
    calendar: { name: 'calendar', transport: { type: 'stdio', command: 'gcal-mcp' } },
  },
});
```

You can also add `mcpServers: ['gmail', 'calendar']` to `pack.json` to make
them required — users who forget to pass them at create time get a clear
error.

## Uninstall

```
npx agent-do uninstall chief-of-staff
```

This removes the copy under `.agent-do/packs/chief-of-staff/` and updates the
install registry. The bundled version is still available for reinstall.
