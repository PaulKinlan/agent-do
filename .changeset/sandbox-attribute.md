---
"agent-do": minor
---

Add a pluggable `sandbox` attribute to `createAgent` (#3).

The new `SandboxApi` contract (a verbatim port of the [Astro Flue
sandbox-connector spec](https://github.com/withastro/flue/blob/main/docs/sandbox-connector-spec.md))
is the lowest-common-denominator surface for sandbox backends — local
interpreters, OS-level filters, and remote VM platforms. Pair it with
the new `SandboxBackedMemoryStore` and `createBashTool` (or the
convenience `createSandboxedToolset(sandbox, agentId)`) to route every
file/shell call through the connector instead of the host.

Two connectors ship in this release:

- `createHostSandbox()` — direct host passthrough. **Not a security
  boundary.** Used as the default fallback when `createBashTool()` is
  called without a sandbox.
- `createJustBashSandbox(opts)` — wraps a [vercel-labs/just-bash](https://github.com/vercel-labs/just-bash)
  `Sandbox` with a virtual filesystem and an in-process bash
  interpreter (optional peer dep). `wrapJustBashSandbox(instance)` is
  also exported for callers that want to construct the underlying
  `Sandbox` themselves.

Network policy is a connector-level concern (each factory takes its
own `allowNet`); the contract stays portable across backends with very
different egress models.

Backward compatible — when `sandbox` is undefined, every existing tool
path is byte-for-byte unchanged.
