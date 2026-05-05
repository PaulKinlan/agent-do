/**
 * Example 18: Sandbox alongside the filesystem store
 *
 * Unlike the in-memory store (example 17), a `FilesystemMemoryStore`
 * shares a substrate with the host: it writes real files to disk. So
 * you have a real choice about how it interacts with the sandbox:
 *
 * **A) Soft policy + sandboxed bash** (the simpler pattern shown here)
 *    - File tools talk to `FilesystemMemoryStore` directly. The host
 *      filesystem IS the substrate.
 *    - Use `readOnly: true` and/or `onBeforeWrite` for soft policy.
 *    - Bash runs through the sandbox so untrusted commands are gated.
 *    - Tradeoff: file_tools and bash see different things — bash is
 *      isolated, but file_tools touch disk directly.
 *
 * **B) Strong isolation via `SandboxBackedMemoryStore`** (commented
 *     out below) — wrap the sandbox in a `MemoryStore` adapter so
 *     file_tools and bash both go through the same connector. With a
 *     truly isolating connector (e.g. just-bash), nothing reaches the
 *     real disk at all.
 *
 * Run: ANTHROPIC_API_KEY=... npx tsx examples/18-sandbox-with-filesystem.ts
 */

import {
  createAgent,
  createBashTool,
  createFileTools,
  createHostSandbox,
  FilesystemMemoryStore,
  // SandboxBackedMemoryStore, // see pattern B below
} from 'agent-do';
import { createAnthropic } from '@ai-sdk/anthropic';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

console.log('═══════════════════════════════════════');
console.log('  Example 18: Sandbox + FilesystemMemoryStore');
console.log('═══════════════════════════════════════\n');

const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })(
  'claude-sonnet-4-6',
);

const baseDir = await mkdtemp(path.join(tmpdir(), 'agent-do-ex18-'));

// Pattern A — file tools on host fs, bash on the sandbox.
const store = new FilesystemMemoryStore(baseDir, {
  // Soft policy: even though file_tools bypass the sandbox, you can
  // still gate writes per-path with onBeforeWrite, or block all
  // writes with readOnly: true.
  onBeforeWrite: async (_agentId, canonicalPath, op) => {
    console.log(`  [policy] ${op} ${canonicalPath}`);
    return !canonicalPath.endsWith('.secret');
  },
});

const sandbox = createHostSandbox({ cwd: baseDir });

const agent = createAgent({
  id: 'demo',
  name: 'Filesystem + Sandbox Demo',
  model: model as any,
  sandbox,
  tools: {
    ...createFileTools(store, 'demo'),
    ...createBashTool(sandbox),
  },
  systemPrompt:
    'You have file tools backed by a real filesystem store, and a ' +
    'bash tool backed by a sandbox. Both can read the same files, but ' +
    'file_tools are gated by an onBeforeWrite policy that blocks any ' +
    'path ending in `.secret`. Be concise.',
  maxIterations: 6,
});

const result = await agent.run(
  'Create a file `notes.md` with one line of content, then run ' +
    '`ls -la` and `cat notes.md` via bash to verify it landed on disk.',
);
console.log(`\nAgent: ${result}\n`);

await rm(baseDir, { recursive: true, force: true });
console.log('✓ Done (cleaned up tempdir).');

// ──────────────────────────────────────────────────────────────────
// Pattern B — strong isolation. Uncomment to try.
//
// import { createJustBashSandbox } from 'agent-do';
// const isolated = await createJustBashSandbox();
// const isolatedStore = new SandboxBackedMemoryStore(isolated);
// const isolatedAgent = createAgent({
//   id: 'iso', name: 'Isolated', model: model as any,
//   sandbox: isolated,
//   tools: {
//     ...createFileTools(isolatedStore, 'iso'),
//     ...createBashTool(isolated),
//   },
// });
// // Files written here live in just-bash's virtual fs and never touch
// // the host. Bash commands run inside the just-bash interpreter.
