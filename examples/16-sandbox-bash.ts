/**
 * Example 16: Shell tool
 *
 * The simplest end-to-end example of the shell tool: we give the
 * agent a `bash` tool wired to a SandboxApi connector. The agent can
 * run shell commands, but only ones the connector permits.
 *
 * This example uses `createHostSandbox()` — a passthrough to the host.
 * **It is not isolation.** The shell tool runs on your real shell, with
 * the same privileges as the Node.js process. The point of this
 * example is to show the *shape* of the API; for real isolation, swap
 * `createHostSandbox` for `createJustBashSandbox` (see example 17).
 *
 * Run: ANTHROPIC_API_KEY=... npx tsx examples/16-sandbox-bash.ts
 */

import {
  createAgent,
  createShellTool,
  createHostSandbox,
} from 'agent-do';
import { createAnthropic } from '@ai-sdk/anthropic';

console.log('═══════════════════════════════════════');
console.log('  Example 16: Shell tool');
console.log('═══════════════════════════════════════\n');

const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })(
  'claude-sonnet-4-6',
);

const sandbox = createHostSandbox();

const agent = createAgent({
  id: 'sandbox-bash',
  name: 'Shell Demo',
  model: model as any,
  tools: createShellTool(sandbox),
  systemPrompt:
    'You can run shell commands via the bash tool. Use it sparingly. Be concise.',
  maxIterations: 5,
});

const result = await agent.run(
  'Run `uname -a` and tell me which OS this is on.',
);
console.log(`Agent: ${result}\n`);

console.log('✓ Done.');
