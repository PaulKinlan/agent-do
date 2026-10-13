---
'agent-do': minor
---

The host sandbox connector no longer hands the parent process environment to commands.
`createHostSandbox()` forwards only `PATH`, `HOME`, the locale variables, `TMPDIR`, `TZ`, `TERM`, `SHELL`,
`USER`, `LOGNAME` and `NODE_ENV`, plus whatever the caller passes as `ExecOptions.env`. A model-controlled
`bash` call can therefore no longer read the provider credentials the host process holds
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AWS_SECRET_ACCESS_KEY`, …) with `printenv` or
`/proc/self/environ`. Forward specific variables with `envPassthrough: ['GIT_AUTHOR_NAME']`, or set
`inheritEnv: true` to restore the previous whole-environment behaviour.
