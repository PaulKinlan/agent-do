# Sandbox

agent-do has a pluggable sandbox layer (issue [#3]). It's a portable
contract — the [Astro Flue `SandboxApi`][flue] — that backends like
just-bash, Vercel Sandbox, Deno Sandbox, and Anthropic's
sandbox-runtime can implement. agent-do ships two connectors out of
the box (host and just-bash) and lets you bring your own.

The agent itself doesn't know about sandboxes. **Sandboxing is a
per-provider concern**: each store and each shell tool decides
whether to route through one. This means you can sandbox just the
shell, just the workspace tools, just memory — or any subset.

```ts
import {
  createAgent,
  createMemoryTools,
  createWorkspaceTools,
  createShellTool,
  createJustBashSandbox,
  SandboxBackedMemoryStore,
} from 'agent-do';

const sandbox = await createJustBashSandbox();
const memoryStore = new SandboxBackedMemoryStore(sandbox, '/memory');

const agent = createAgent({
  id: 'geo', name: 'Geo', model,
  tools: {
    ...createMemoryTools(memoryStore, 'geo'),       // memory_* through sandbox
    ...createWorkspaceTools('/work', { sandbox }),  // file_* through sandbox
    ...createShellTool(sandbox),                    // bash through sandbox
  },
});
```

You can mix freely: keep memory in-memory, route workspace through a
sandbox, and use a different sandbox for the shell.

## Contract

A verbatim port of [Flue's spec][flue]:

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
| `createHostSandbox(opts?)` | `node:fs/promises` + `child_process` | host (none) | Default fallback for `createShellTool()`. **Not a security boundary.** |
| `createJustBashSandbox(opts?)` | [vercel-labs/just-bash][just-bash] virtual fs + interpreter | `allowNet` fetch hook inside the interpreter | Optional peer dep — install `just-bash` to use. |
| `wrapJustBashSandbox(instance)` | as above | as above | For callers that construct the underlying just-bash `Sandbox` themselves. |

Other backends (Vercel Sandbox, Deno Sandbox, Anthropic
sandbox-runtime) aren't shipped — implement your own against
`SandboxApi`. The contract suite at `tests/sandbox/contract.ts` is
reusable.

## Network policy

Network policy is **a connector-level concern, not a method on
`SandboxApi`**. Each factory takes its own `allowNet` shape that
matches what the underlying runtime exposes:

- **just-bash** intercepts `fetch` / `curl` inside the interpreter.
- **host** has no network policy — every network call goes straight
  out.

A `fetch?(url, init)` method on `SandboxApi` was deliberately
rejected: backends have fundamentally different network surfaces, and
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

## Tool factories

The three consumer-facing tool factories are:

| Factory | Tool names model sees | Sandbox involvement |
|---|---|---|
| `createMemoryTools(store, agentId)` | `memory_read`, `memory_write`, `memory_list`, `memory_delete`, `memory_search` | Pass a `SandboxBackedMemoryStore(sandbox, root)` if you want sandboxed memory. |
| `createWorkspaceTools(workingDir, opts)` | `read_file`, `write_file`, `edit_file`, `list_directory`, `delete_file`, `grep_file`, `find_files` | Pass `{ sandbox }` to swap the internal store for a sandbox-backed one. |
| `createShellTool(sandbox?)` | `bash` (or your `name` override) | Takes a sandbox directly. Defaults to `createHostSandbox()` if none supplied. |

`createMemoryTools` and `createShellTool` overlap on capability with
`createWorkspaceTools` (the shell can `cat`, `ls`, etc.) but they're
positioned for different patterns:

- **Workspace tools** — structured per-op tools, deny-list at the tool
  layer, per-tool permissions, structured tool output.
- **Shell tool** — one general-purpose tool, maximum flexibility.

Use both together when you want guarded I/O *and* arbitrary command
execution.

## Soft safety vs. strong isolation

`FilesystemMemoryStore`'s `readOnly` / `onBeforeWrite` knobs are
**soft policy hooks** — useful for narrow gating, but not a security
boundary (a future tool that calls `node:fs` directly bypasses them).
The sandbox is the **strong boundary**: when you wire stores and
shell through `SandboxBackedMemoryStore` / a real isolating
connector, no path inside the agent can reach host fs without passing
through the connector.

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

[#3]: https://github.com/PaulKinlan/agent-do/issues/3
[flue]: https://github.com/withastro/flue/blob/main/docs/sandbox-connector-spec.md
[just-bash]: https://github.com/vercel-labs/just-bash
