/**
 * Example 16: Sandbox + bash tool
 *
 * The simplest end-to-end example of the sandbox attribute (#3): we
 * give the agent a `bash` tool wired to a SandboxApi connector. The
 * agent can run shell commands, but only ones the connector permits.
 *
 * This example uses `createHostSandbox()` — a passthrough to the host.
 * **It is not isolation.** The bash tool runs on your real shell, with
 * the same privileges as the Node.js process. The point of this
 * example is to show the *shape* of the API; for real isolation, swap
 * `createHostSandbox` for `createJustBashSandbox` (see example 17).
 *
 * Run: ANTHROPIC_API_KEY=... npx tsx examples/16-sandbox-bash.ts
 */

import {
  createAgent,
  createBashTool,
  createHostSandbox,
} from 'agent-do';
import { createAnthropic } from '@ai-sdk/anthropic';

console.log('═══════════════════════════════════════');
console.log('  Example 16: Sandbox + bash');
console.log('═══════════════════════════════════════\n');

const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })(
  'claude-sonnet-4-6',
);

const sandbox = createHostSandbox();

const agent = createAgent({
  id: 'sandbox-bash',
  name: 'Sandbox Bash',
  model: model as any,
  sandbox,
  tools: createBashTool(sandbox),
  systemPrompt:
    'You can run shell commands via the bash tool. Use it sparingly. Be concise.',
  maxIterations: 5,
});

const result = await agent.run(
  'Run `uname -a` and tell me which OS this is on.',
);
console.log(`Agent: ${result}\n`);

console.log('✓ Done.');
