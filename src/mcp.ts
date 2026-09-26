/**
 * MCP (Model Context Protocol) server mounting — Node implementation.
 *
 * Extends the browser-safe core by registering the StdioClientTransport
 * so Node environments can spawn local MCP servers via subprocesses.
 */

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { registerStdioTransportFactory } from './mcp-core.js';

registerStdioTransportFactory((config) => {
  return new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: config.env,
    cwd: config.cwd,
  });
});

export * from './mcp-core.js';
