---
"agent-do": minor
---

Add a slash-command router (`AgentConfig.slashCommands`): when a user's task starts with `/<name>`, the loop deterministically dispatches the remainder to a configured sub-agent BEFORE any model call on the parent — zero LLM cost, zero tool round-trips. An unknown `/<name>` returns a listing of available commands without calling the parent model; non-slash input bypasses the router unchanged.

Sub-agents are full `Agent` instances (own model, tools, skills, routines, permissions, hooks). Keys must match `/^[a-zA-Z0-9_-]+$/`; nested slash commands (`/a/b`) are rejected at `createAgent()` time. Parent conversation history is not forwarded to the sub-agent by default. The CLI passes input through unchanged, so `npx agent-do run <agent> "/research X"` routes correctly.

New exports: `parseSlashCommand`, `unknownSlashCommandMessage`, `validateSlashCommands`. See `examples/21-slash-commands.ts`.
