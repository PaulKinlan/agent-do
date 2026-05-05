# Sandbox

agent-do has a pluggable sandbox attribute on `createAgent` ([#3]). When
set, callers can route every tool I/O call through a `SandboxApi`
connector instead of the host filesystem and shell.

```ts
import {
  createAgent,
  createJustBashSandbox,
  createSandboxedToolset,
} from 'agent-do';

const sandbox = await createJustBashSandbox({
  files: { '/data/seed.txt': 'hello' },
  allowNet: false, // gate fetch/curl inside the interpreter
});

const agent = createAgent({
  id: 'geo',
  name: 'Geo',
  model,
  sandbox,
  tools: createSandboxedToolset(sandbox, 'geo'),
});
```

The `sandbox` field is the single source of truth that hooks and tools
look up by reference. The loop does not auto-rewire your existing tools
when it's set — wire them through `SandboxBackedMemoryStore` /
`createBashTool` / `createSandboxedToolset` explicitly.

## Contract

The contract is a verbatim port of the [Astro Flue sandbox-connector
spec](https://github.com/withastro/flue/blob/main/docs/sandbox-connector-spec.md).

```ts
interface SandboxApi {
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<FileStat>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
}
```

No streaming, no stdin. Connectors fall back to `exec('mkdir -p …')`
etc. when their backend lacks a primitive — Flue's documented
convention.

## Connectors

| Factory | Backend | Network model | Status |
|---|---|---|---|
| `createNoopSandbox()` | `node:fs/promises` + `child_process` | host (none) | shipped — **not a security boundary** |
| `createJustBashSandbox(opts)` | [vercel-labs/just-bash](https://github.com/vercel-labs/just-bash) virtual fs + interpreter | `allowNet` fetch hook inside the interpreter | shipped (optional peer dep) |
| `createSandboxRuntimeSandbox(cfg)` | [@anthropic-ai/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) (sandbox-exec on macOS, bubblewrap on Linux) | OS-level `allowedDomains` filter | stub — implementation deferred |
| `createVercelSandbox({ sandbox })` | `@vercel/sandbox` Firecracker microVM | VM egress (configured on the supplied instance) | stub — implementation deferred |
| `createDenoSandbox(opts)` | Deno Sandbox SDK | `--allow-net` domain allowlist | stub — implementation deferred |

`seatbelt` is *not* shipped as a standalone connector — sandbox-runtime
already drives `sandbox-exec` on darwin and exposes a richer config
surface. A standalone seatbelt connector would duplicate it.

## Network policy

Network policy is **a connector-level concern, not a method on
`SandboxApi`**. Each factory takes its own `allowNet` /
`allowedDomains` shape that matches what the underlying runtime
exposes:

- **just-bash** intercepts `fetch` / `curl` inside the interpreter.
- **sandbox-runtime** uses an OS-level filter (`network.allowedDomains`).
- **Deno** translates allowlists into `--allow-net` flags.
- **Vercel** configures egress on the `@vercel/sandbox` instance the
  caller supplies.

A `fetch?(url, init)` method on `SandboxApi` was deliberately rejected:
those four runtimes have fundamentally different network surfaces, and
a method that only some connectors implement would tempt callers to
assume it exists. TypeScript interfaces are open, so a future
`SandboxApiWithFetch extends SandboxApi` can land non-breakingly if the
use case appears.

## Soft safety vs. strong isolation

`FilesystemMemoryStore`'s `readOnly` / `onBeforeWrite` knobs remain in
place. Those are **soft policy hooks** — not a security boundary, since
a future tool that calls `node:fs` directly bypasses them. The sandbox
is the **strong boundary**: when you wire tools through
`SandboxBackedMemoryStore`, no path inside the agent can reach host fs
without passing through the connector.

`SandboxBackedMemoryStore` mirrors the same `readOnly` /
`onBeforeWrite` shape so you can layer policy *on top* of isolation.

## What's not in scope

- **Session lifecycle** — Flue's `createSessionEnv` / cleanup
  convention. Useful for cloud sandboxes; punt.
- **Secret injection at the proxy layer** — needs a `fetch` capability
  we deliberately didn't add to the contract yet.
- **Resource limits** beyond `exec.timeout` — connector-specific.
- **Snapshotting / restore** — Vercel and just-bash both support it;
  deserves its own `SnapshotCapability` extension.
- **Auto-wrapping `MemoryStore` when a sandbox is set** — possible
  later as a non-breaking addition. v1 is intentionally explicit.

[#3]: https://github.com/PaulKinlan/agent-do/issues/3
