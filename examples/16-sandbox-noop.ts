/**
 * Example 16: Sandbox + bash tool (noop connector)
 *
 * Demonstrates the new pluggable sandbox attribute on createAgent (#3).
 * The noop connector is a host-fs / host-shell passthrough — *not* a
 * security boundary. It exists so the SandboxApi shape is usable for
 * tests and so `createBashTool` can be opted into a real shell with a
 * deliberate, named choice. For real isolation, swap in
 * `createJustBashSandbox()` (in-process) or one of the future cloud
 * connectors (sandbox-runtime, Vercel Sandbox, Deno Sandbox).
 *
 * Run: ANTHROPIC_API_KEY=... npx tsx examples/16-sandbox-noop.ts
 */

import {
  createAgent,
  createBashTool,
  createNoopSandbox,
} from 'agent-do';
import { createAnthropic } from '@ai-sdk/anthropic';

console.log('═══════════════════════════════════════');
console.log('  Example 16: Sandbox + bash (noop)');
console.log('═══════════════════════════════════════\n');

const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })(
  'claude-sonnet-4-6',
);

const sandbox = createNoopSandbox();

const agent = createAgent({
  id: 'sandbox-demo',
  name: 'Sandbox Demo',
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
