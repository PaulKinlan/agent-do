/**
 * Example 17: Sandbox alongside an in-memory store
 *
 * Demonstrates that a sandbox and a `MemoryStore` are *independent*
 * concerns. The sandbox protects whatever shares a substrate with the
 * host (its filesystem, its shell, its network); a store that doesn't
 * share that substrate (in-memory, S3, Firestore, etc.) doesn't need
 * to go through the sandbox at all.
 *
 * Here we wire two things into the agent at the same time:
 *
 *   1. `InMemoryMemoryStore` — file_tools (read_file/write_file/…)
 *      operate on this. Lives entirely in process memory, never
 *      touches host fs, so it bypasses the sandbox by design.
 *   2. `bash` tool — backed by the host sandbox. The agent can
 *      shell out, but the in-memory store remains separate from
 *      anything the bash tool produces.
 *
 * Run: ANTHROPIC_API_KEY=... npx tsx examples/17-sandbox-with-memory.ts
 */

import {
  createAgent,
  createBashTool,
  createFileTools,
  createHostSandbox,
  InMemoryMemoryStore,
} from 'agent-do';
import { createAnthropic } from '@ai-sdk/anthropic';

console.log('═══════════════════════════════════════');
console.log('  Example 17: Sandbox + in-memory store');
console.log('═══════════════════════════════════════\n');

const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })(
  'claude-sonnet-4-6',
);

const store = new InMemoryMemoryStore();
const sandbox = createHostSandbox();

const agent = createAgent({
  id: 'demo',
  name: 'Mixed Tools Demo',
  model: model as any,
  sandbox,
  tools: {
    // file_tools talk to the in-memory store directly. No sandbox
    // involvement — the store has no substrate the sandbox can protect.
    ...createFileTools(store, 'demo'),
    // bash talks to the sandbox. Anything the agent shells out into
    // is mediated by the connector.
    ...createBashTool(sandbox),
  },
  systemPrompt:
    'You have file tools (in-memory) and a bash tool (host shell). ' +
    'Files written via write_file are NOT visible to bash, and vice versa — ' +
    'they live in different substrates. Use whichever fits the task.',
  maxIterations: 6,
});

const result = await agent.run(
  'Write a haiku to "haiku.txt" using write_file. Then use bash to ' +
    'print today\'s date. Don\'t try to cat haiku.txt with bash — it ' +
    'lives in your in-memory store, not on disk.',
);
console.log(`Agent: ${result}\n`);

const stored = await store.read('demo', 'haiku.txt').catch(() => '(not found)');
console.log('In-memory store contents:');
console.log(stored);

console.log('\n✓ Done.');
