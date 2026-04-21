# Research Team pack

A four-agent research pipeline: **scout → analyst → synthesiser →
fact-checker**. Ships the rubrics as skills and the end-to-end flow as a
`daily-digest` routine — extends the shape of `demos/research-team` into a
reusable composition.

## What's inside

| Component | Files |
|-----------|-------|
| Skills    | `scout-brief`, `synthesis-rubric`, `fact-check` |
| Routines  | `daily-digest` |
| Tools     | Workspace tools rooted at the working directory |
| Variables | `topic` (required) |

## Install

```
npx agent-do install research-team
```

## Use

```ts
import { createTemplatePack } from 'agent-do';
import { createAnthropic } from '@ai-sdk/anthropic';

const { agent } = await createTemplatePack('research-team', {
  model: createAnthropic()('claude-sonnet-4-6'),
  variables: { topic: 'AI agents' },
  workingDir: './research',
});

// Trigger the full pipeline for today's digest:
const report = await agent.run('Run the daily-digest routine for today.');
```

## MCP bindings

For a real research team you'd mount a web-search MCP and (optionally) a
Drive / Notion MCP for publishing. Wire them at create time:

```ts
const { agent } = await createTemplatePack('research-team', {
  model,
  variables: { topic: 'AI agents' },
  mcpServers: {
    search: { name: 'search', transport: { type: 'stdio', command: 'web-search-mcp' } },
  },
});
```

## Customising

Edit the rubrics in `skills/` after install to add domain-specific
verification rules (e.g. "always cite primary sources for medical claims").
