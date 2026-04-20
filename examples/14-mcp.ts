/**
 * Example 14: MCP (Model Context Protocol) servers
 *
 * Mount an external MCP server and let the agent use its tools.
 * agent-do auto-namespaces discovered tools as `mcp__<server>__<tool>`
 * and handles the server lifecycle (spawn on run, close on completion,
 * close on error/abort so subprocesses don't leak).
 *
 * This example uses the official filesystem reference server. Install
 * it first:
 *
 *   npm install -g @modelcontextprotocol/server-filesystem
 *
 * …or use `npx` in the transport config (shown below) so the SDK
 * downloads it on demand.
 *
 * Run: npx tsx examples/14-mcp.ts
 */

import { createAgent } from 'agent-do';
import { createAnthropic } from '@ai-sdk/anthropic';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

console.log('═══════════════════════════════════════');
console.log('  Example 14: MCP server mounting');
console.log('═══════════════════════════════════════\n');

// Set up a sandbox directory with a couple of files so the filesystem
// MCP server has something to poke at.
const sandbox = mkdtempSync(join(tmpdir(), 'agent-do-mcp-'));
writeFileSync(
  join(sandbox, 'notes.md'),
  '# Notes\n\n- buy milk\n- book doctor appointment\n- renew passport\n',
);
writeFileSync(
  join(sandbox, 'todo.md'),
  '# TODO\n\n- [ ] Finish the report\n- [x] Reply to Alice\n- [ ] Book flights\n',
);
console.log(`Sandbox directory: ${sandbox}\n`);

const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })(
  'claude-sonnet-4-6',
);

// Mount the filesystem MCP server, scoped to our sandbox directory.
// Tools will be discovered at run-start and exposed to the model as
// mcp__fs__read_text_file, mcp__fs__list_directory, etc.
const agent = createAgent({
  id: 'fs-assistant',
  name: 'Filesystem Assistant',
  model: model as any,
  systemPrompt:
    'You are a helpful assistant with read-only access to a small workspace of markdown files. Use the filesystem tools to answer questions about the files.',
  mcpServers: [
    {
      name: 'fs',
      transport: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', sandbox],
      },
      // Scope down to the safe subset — the filesystem server also
      // exposes write and edit tools, but for this demo we only need
      // to read.
      allowedTools: ['read_text_file', 'list_directory', 'directory_tree'],
    },
  ],
  maxIterations: 5,
});

console.log('Task: "What TODOs do I have left?"\n');
console.log('The agent should call mcp__fs__list_directory to find todo.md,');
console.log('then mcp__fs__read_text_file to load it, then filter to open items.\n');

const result = await agent.run('What TODOs do I have left?');

console.log('Agent output:\n');
result.split('\n').forEach((line) => console.log(`   ${line}`));
console.log('');

console.log('Done — MCP servers are automatically closed when the run ends.');
