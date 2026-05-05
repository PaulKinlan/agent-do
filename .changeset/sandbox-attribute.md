---
"agent-do": minor
---

Add a pluggable sandbox layer (#3).

`SandboxApi` is a verbatim port of the [Astro Flue sandbox-connector
spec](https://github.com/withastro/flue/blob/main/docs/sandbox-connector-spec.md):
the lowest-common-denominator surface for sandbox backends — local
interpreters, OS-level filters, and remote VM platforms.

Sandboxing is **per-provider**: each store and each tool decides
whether to route through a sandbox. There is no global agent-level
field. To sandbox a piece of the agent's surface:

- Memory: `createMemoryTools(new SandboxBackedMemoryStore(sandbox, '/memory'), agentId)`
- Workspace files: `createWorkspaceTools(workingDir, { sandbox })`
- Shell: `createShellTool(sandbox)`

Two connectors ship in this release:

- `createHostSandbox()` — direct host passthrough. **Not a security
  boundary.** Used as the default fallback when `createShellTool()` is
  called without a sandbox.
- `createJustBashSandbox(opts)` — wraps a [vercel-labs/just-bash](https://github.com/vercel-labs/just-bash)
  `Sandbox` with a virtual filesystem and an in-process bash
  interpreter (optional peer dep). `wrapJustBashSandbox(instance)` is
  also exported for callers that want to construct the underlying
  `Sandbox` themselves.

New consumer-facing factory: **`createShellTool(sandbox?, opts?)`** —
returns a single shell tool (default model name `bash`) wired to a
SandboxApi.

`createWorkspaceTools` gains an optional `sandbox` option — when set,
the internal store becomes `SandboxBackedMemoryStore` instead of
`FilesystemMemoryStore`, so the same factory works for host fs and
sandboxed alike.

Network policy is a connector-level concern (each factory takes its
own `allowNet`); the contract stays portable across backends with
very different egress models.

`createFileTools` is no longer publicly exported — it was the
low-level primitive `createWorkspaceTools` builds on, and the public
overlap with `createMemoryTools` was confusing. Migrate to
`createMemoryTools` (for in-memory / store-backed scratchpads) or
`createWorkspaceTools` (for filesystem-rooted file ops).
