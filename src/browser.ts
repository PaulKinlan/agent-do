/**
 * Browser entry (GH #139, agent-do-5ep) — the parts of agent-do that run anywhere.
 *
 * `agent-do`'s default entry is a Node library: it exports a filesystem-backed workspace, a shell tool, a
 * host sandbox connector and a stdio MCP transport, all of which need `node:child_process`, `node:fs`,
 * `node:os` or Node streams. That is correct for the Node entry, but it means an application that only
 * wants the loop (a web app driving an agent against remote tools) cannot import the package at all: a
 * `platform: 'browser'` bundle resolves `index → agent → loop → mcp → stdio → cross-spawn` and fails.
 *
 * This entry exports the maximum that is genuinely portable, and nothing else:
 *
 * - **The real loop.** `runAgentLoop` / `streamAgentLoop` are the same functions the Node entry exports -
 *   not a reimplementation - together with `buildOnStepEnd`, so per-step usage accounting works.
 * - **Routines**: the markdown parser, interpolation, the routine tool factory and `InMemoryRoutineStore`.
 *   The filesystem store needs `node:fs` and lives in `./routines/filesystem.js`; it is deliberately not
 *   reachable from here.
 * - **Cron validation**: `matchesCron` plus `validateScheduledTasks` and their types. The locked run path
 *   (status files + the #15 file lock) needs `node:fs`/`node:os`/`node:crypto` and lives in
 *   `./scheduled-tasks/fs.js`.
 * - **Remote MCP**: `mountRemoteMcpServers`, which accepts `http`/`sse` transports. The stdio transport
 *   spawns a child process through `cross-spawn`, so it is not usable from a browser; this entry refuses a
 *   `stdio` config with a clear error rather than failing later inside a bundler or a dynamic import.
 *
 * What is *not* here, on purpose: the filesystem workspace tools, the shell tool, the host sandbox
 * connector, `FilesystemRoutineStore`, the scheduled-task runner and `createAgent`. Each of those needs a
 * Node capability, and an import that silently pulls one in is exactly the defect this entry exists to
 * prevent.
 *
 * The property is checked, not asserted: `tests/browser-entry.test.ts` walks the real import graph from
 * this file the way a bundler would and fails if any `node:` builtin, bare `process` access, `require`,
 * `__dirname` or `import.meta.url` becomes reachable — and it fails if the Node-only halves above come
 * back into the graph.
 */
import {
  mountMcpServers,
  type McpServerConfig,
  type MountedMcpServers,
  type McpTransportConfig,
} from './mcp.js';

// The real loop.
export { buildOnStepEnd, runAgentLoop, streamAgentLoop } from './loop.js';

// Routines — pure helpers and the in-memory store.
export {
  createRoutineTools,
  InMemoryRoutineStore,
  interpolateRoutine,
  parseRoutineMd,
} from './routines.js';
export type { CreateRoutineToolsOptions } from './routines.js';
export type { Routine, RoutineInput, RoutineStore } from './types.js';

// Scheduled tasks — the cron matcher and the config validator.
export { matchesCron, validateScheduledTasks } from './scheduled-tasks.js';
export type { ScheduledTask, ScheduledTasksConfig, StatusRecord, TaskStatus } from './scheduled-tasks.js';

// MCP — remote transports only.
export { MCP_TOOL_PREFIX, namespacedToolName } from './mcp.js';
export type { McpServerConfig, McpTransportConfig, MountedMcpServers };

/** MCP transports that a browser can open. `stdio` spawns a process and is Node-only. */
export type RemoteMcpTransportConfig = Extract<McpTransportConfig, { type: 'http' | 'sse' }>;

/**
 * Mount MCP servers over the remote (`http` / `sse`) transports.
 *
 * Same contract as {@link mountMcpServers} — tool namespacing, injection wrapping, per-server isolation —
 * with the Node-only stdio transport rejected up front. The rejection is deliberate and typed, and it is
 * implemented once, in `mountMcpServers`, keyed on `allowStdio`; this function simply pins that option to
 * `false`. The same check therefore protects `runAgentLoop`, which mounts through `mountConfigMcp` with the
 * runtime probe as its default (agent-do-5sh).
 */
export async function mountRemoteMcpServers(
  configs: McpServerConfig[],
): Promise<MountedMcpServers> {
  // Delegates rather than re-implementing the check: the rejection lives in the shared mount path, so this
  // helper and `runAgentLoop` (which mounts through `mountConfigMcp`) cannot drift apart again (agent-do-5sh).
  return mountMcpServers(configs, { allowStdio: false });
}
