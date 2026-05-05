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

| Factory | Backend | Network model | Notes |
|---|---|---|---|
| `createHostSandbox(opts?)` | `node:fs/promises` + `child_process` | host (none) | Default fallback for `createBashTool()`. **Not a security boundary.** |
| `createJustBashSandbox(opts?)` | [vercel-labs/just-bash](https://github.com/vercel-labs/just-bash) virtual fs + interpreter | `allowNet` fetch hook inside the interpreter | Optional peer dep — install `just-bash` to use. |
| `wrapJustBashSandbox(instance)` | as above | as above | For callers that construct the underlying just-bash `Sandbox` themselves. |

Other connectors (Vercel Sandbox, Deno Sandbox, Anthropic
sandbox-runtime) are not shipped in this release. Implement your own
against the `SandboxApi` interface; the contract test suite at
`tests/sandbox/contract.ts` is reusable.

## Network policy

Network policy is **a connector-level concern, not a method on
`SandboxApi`**. Each factory takes its own `allowNet` shape that
matches what the underlying runtime exposes:

- **just-bash** intercepts `fetch` / `curl` inside the interpreter.
- **host** has no network policy — every network call goes straight
  out.

A `fetch?(url, init)` method on `SandboxApi` was deliberately rejected:
different backends have fundamentally different network surfaces, and
a method that only some connectors implement would tempt callers to
assume it exists. TypeScript interfaces are open, so a future
`SandboxApiWithFetch extends SandboxApi` can land non-breakingly if
the use case appears.

## When does a `MemoryStore` go through the sandbox?

Short version: **only when its substrate is the host.** Stores that
write to a separate substrate (in-memory, S3, Firestore, a remote
database) are already isolated by their own boundary and don't need
the sandbox.

| Store | Substrate | Goes through sandbox? |
|---|---|---|
| `InMemoryMemoryStore` | process memory | No — already isolated. |
| `FilesystemMemoryStore` | host disk | Optional. Use soft policy (`readOnly` / `onBeforeWrite`) for light gating, or wrap the sandbox in `SandboxBackedMemoryStore` for hard isolation. |
| Hypothetical `S3MemoryStore` | remote object store | No — different substrate. (Network policy could matter; see above.) |
| `SandboxBackedMemoryStore` | whatever the sandbox protects | Yes — by definition. |

The two shipped examples cover both patterns:

- `examples/17-sandbox-with-memory.ts` — in-memory store + sandbox bash, side by side.
- `examples/18-sandbox-with-filesystem.ts` — filesystem store + sandbox bash, with the strong-isolation pattern documented in a comment.

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
- **Snapshotting / restore** — deserves its own `SnapshotCapability`
  extension.
- **Auto-wrapping `MemoryStore` when a sandbox is set** — possible
  later as a non-breaking addition. v1 is intentionally explicit.

[#3]: https://github.com/PaulKinlan/agent-do/issues/3
