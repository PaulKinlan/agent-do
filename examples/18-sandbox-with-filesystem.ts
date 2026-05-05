/**
 * Example 18: Workspace tools with sandbox isolation
 *
 * Unlike the in-memory store (example 17), the workspace tools'
 * substrate IS the host filesystem. So you have a real choice about
 * whether to route through a sandbox:
 *
 * **A) Soft policy + sandboxed bash** (the simpler pattern shown here)
 *    - `createWorkspaceTools(workingDir)` — file tools talk to host
 *      fs directly via the internal FilesystemMemoryStore.
 *    - Use `readOnly: true` and/or `onBeforeWrite` for soft policy.
 *    - Bash goes through the sandbox so untrusted commands are gated.
 *    - Tradeoff: file tools and bash see different things — bash is
 *      isolated, but file ops touch disk directly.
 *
 * **B) Strong isolation via `{ sandbox }` on workspace tools**
 *     (commented out below) — pass a sandbox to `createWorkspaceTools`
 *     so the internal store becomes `SandboxBackedMemoryStore`. With
 *     a truly isolating connector (e.g. just-bash), nothing reaches
 *     the real disk.
 *
 * Run: ANTHROPIC_API_KEY=... npx tsx examples/18-sandbox-with-filesystem.ts
 */

import {
  createAgent,
  createShellTool,
  createWorkspaceTools,
  createHostSandbox,
} from 'agent-do';
import { createAnthropic } from '@ai-sdk/anthropic';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

console.log('═══════════════════════════════════════');
console.log('  Example 18: Workspace tools + shell');
console.log('═══════════════════════════════════════\n');

const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })(
  'claude-sonnet-4-6',
);

const baseDir = await mkdtemp(path.join(tmpdir(), 'agent-do-ex18-'));

const sandbox = createHostSandbox({ cwd: baseDir });

// Pattern A — file tools on host fs (with policy gates), shell on the sandbox.
const agent = createAgent({
  id: 'demo',
  name: 'Filesystem + Shell Demo',
  model: model as any,
  tools: {
    ...createWorkspaceTools(baseDir, {
      // Soft policy: even though file_tools bypass the sandbox, you
      // can still gate writes per-path with onBeforeWrite, or block
      // all writes with readOnly: true.
      onBeforeWrite: async (canonicalPath, op) => {
        console.log(`  [policy] ${op} ${canonicalPath}`);
        return !canonicalPath.endsWith('.secret');
      },
    }),
    ...createShellTool(sandbox),
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
// const isolatedAgent = createAgent({
//   id: 'iso', name: 'Isolated', model: model as any,
//   tools: {
//     // workspace tools route through SandboxBackedMemoryStore(isolated, '/work')
//     // — file ops never touch host fs.
//     ...createWorkspaceTools('/work', { sandbox: isolated }),
//     ...createShellTool(isolated),
//   },
// });
