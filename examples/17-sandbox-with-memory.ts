/**
 * Example 17: Shell tool alongside an in-memory store
 *
 * Demonstrates that the shell and memory are *independent* concerns.
 * The shell tool's sandbox protects whatever shares a substrate with
 * the host; a store that doesn't share that substrate (in-memory, S3,
 * Firestore, etc.) doesn't need to go through the sandbox at all.
 *
 * Here we wire two things into the agent at the same time:
 *
 *   1. `createMemoryTools(InMemoryMemoryStore, agentId)` — `memory_*`
 *      tools (memory_read/memory_write/...). Lives entirely in process
 *      memory, never touches host fs or shell.
 *   2. `createShellTool(sandbox)` — `bash` tool backed by the host
 *      sandbox. The agent can shell out, but the in-memory store
 *      remains separate from anything bash produces.
 *
 * Run: ANTHROPIC_API_KEY=... npx tsx examples/17-sandbox-with-memory.ts
 */

import {
  createAgent,
  createShellTool,
  createMemoryTools,
  createHostSandbox,
  InMemoryMemoryStore,
} from 'agent-do';
import { createAnthropic } from '@ai-sdk/anthropic';

console.log('═══════════════════════════════════════');
console.log('  Example 17: Shell + in-memory store');
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
  tools: {
    // memory_* talks to the in-memory store directly. No sandbox
    // involvement — the store has no substrate the sandbox can protect.
    ...createMemoryTools(store, 'demo'),
    // bash talks to the sandbox. Anything the agent shells out into
    // is mediated by the connector.
    ...createShellTool(sandbox),
  },
  systemPrompt:
    'You have memory tools (in-memory scratchpad) and a bash tool ' +
    '(host shell). Notes written via memory_write are NOT visible to ' +
    'bash, and vice versa — they live in different substrates. Use ' +
    'whichever fits the task.',
  maxIterations: 6,
});

const result = await agent.run(
  'Save a haiku to "haiku.md" using memory_write. Then use bash to ' +
    'print today\'s date. Don\'t try to cat haiku.md with bash — it ' +
    'lives in your in-memory scratchpad, not on disk.',
);
console.log(`Agent: ${result}\n`);

const stored = await store.read('demo', 'haiku.md').catch(() => '(not found)');
console.log('In-memory store contents:');
console.log(stored);

console.log('\n✓ Done.');
