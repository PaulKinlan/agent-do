---
'agent-do': patch
---

Internal refactor: `mountConfigMcp` moved to `src/mcp.ts` and `tryRouteSlashCommandRun` to
`src/slash-commands.ts`, the sixth step of splitting `src/loop.ts` by responsibility. No behaviour change: both
functions are byte-identical to their previous form, and neither was exported from the loop module.
