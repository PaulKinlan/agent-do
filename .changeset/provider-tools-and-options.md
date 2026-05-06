---
"agent-do": minor
---

Provider-native tools and `providerOptions` are now configurable from the CLI and saved agents.

- New `AgentConfig.providerOptions` field is forwarded verbatim to every `streamText` call. Use it for Google `useSearchGrounding`, Anthropic `thinking`, OpenAI `reasoningEffort`, and other provider-specific call options.
- New CLI flags: `--provider-tool <name>` (repeatable, comma-separated values accepted) and `--provider-options '<json>'`. Tool names resolve against the installed provider SDK's `<provider>.tools` surface, with short aliases like `webSearch → webSearch_20260209`. Works in prompt mode, saved agents, and script mode (Format 3).
- `SavedAgentSchema` gained optional `providerTools` and `providerOptions` fields so saved agents can persist the same configuration. `create` accepts the new flags, and the new fields are merged into the agent's tool set / call options at run time.
