/**
 * MCP (Model Context Protocol) server mounting — core & browser implementation.
 *
 * Spawns / connects to MCP servers, lists their tools, and wraps each one
 * as a Vercel AI SDK dynamic tool so the agent loop can invoke them
 * alongside local tools.
 *
 * This core module supports remote MCP transports (SSE and Streamable HTTP)
 * without any Node built-in dependencies (no child_process, no cross-spawn,
 * no node:module). The Node stdio transport is registered dynamically by
 * the Node entry point (mcp.ts).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { dynamicTool, jsonSchema, type ToolSet } from 'ai';
import { wrapForModel } from './tools/content-guards.js';

export const LIB_VERSION = '0.7.0';

/**
 * A single MCP server to mount. `name` is the namespace used to prefix
 * tool names (`mcp__<name>__<tool>`); it must be unique across the set.
 * Must match `^[a-zA-Z0-9_-]+$` so the generated tool names are safe
 * across every provider's naming rules.
 */
export interface McpServerConfig {
  /** Unique namespace for this server. Tools become `mcp__<name>__<tool>`. */
  name: string;
  transport: McpTransportConfig;
  /**
   * Per-tool name filter. If set, only tools whose bare name matches are
   * exposed to the model. Useful when a server offers dozens of tools
   * but the agent only needs a couple.
   */
  allowedTools?: string[];
}

export type McpTransportConfig =
  | {
      type: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | {
      type: 'sse';
      url: string;
      headers?: Record<string, string>;
    }
  | {
      type: 'http';
      url: string;
      headers?: Record<string, string>;
    };

/**
 * Result of {@link mountMcpServers}. `tools` is an AI SDK `ToolSet` that
 * callers merge into their existing tools. `close()` releases every
 * server's transport and should be called on agent shutdown to avoid
 * leaked subprocesses.
 */
export interface MountedMcpServers {
  tools: ToolSet;
  /** Tool name → server namespace, for debugging / logging. */
  toolOrigins: Record<string, string>;
  close: () => Promise<void>;
}

/**
 * Regex for acceptable MCP server namespaces *and* tool names.
 */
export const NAMESPACE_RE = /^(?!.*__)[a-zA-Z0-9_-]+$/;
/** Prefix applied to every MCP-sourced tool name. */
export const MCP_TOOL_PREFIX = 'mcp__';

/**
 * Build the namespaced tool name. Exported so tests and debug output can
 * reuse the convention without re-deriving it.
 */
export function namespacedToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}__${toolName}`;
}

export type StdioTransportFactory = (config: Extract<McpTransportConfig, { type: 'stdio' }>) => Transport;
let stdioTransportFactory: StdioTransportFactory | null = null;

/**
 * Register a stdio transport factory. In Node environments, mcp.ts registers
 * StdioClientTransport so stdio subprocesses can be spawned.
 */
export function registerStdioTransportFactory(factory: StdioTransportFactory): void {
  stdioTransportFactory = factory;
}

/**
 * Connect to each MCP server in `configs`, list their tools, and return
 * them merged as a single AI SDK `ToolSet`.
 */
export async function mountMcpServers(
  configs: McpServerConfig[],
): Promise<MountedMcpServers> {
  const seen = new Set<string>();
  for (const config of configs) {
    if (!NAMESPACE_RE.test(config.name)) {
      throw new TypeError(
        `MCP server name "${config.name}" must match ${NAMESPACE_RE}`,
      );
    }
    if (seen.has(config.name)) {
      throw new TypeError(`Duplicate MCP server name "${config.name}"`);
    }
    seen.add(config.name);
  }

  const clients: Client[] = [];
  const tools: ToolSet = {};
  const toolOrigins: Record<string, string> = {};
  let closed = false;

  const closeAll = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await Promise.allSettled(
      [...clients].reverse().map((c) =>
        c.close().catch(() => {
          /* close errors are non-fatal — we're already tearing down */
        }),
      ),
    );
  };

  try {
    for (const config of configs) {
      const client = new Client({
        name: 'agent-do',
        version: LIB_VERSION,
      });

      clients.push(client);

      const transport = createTransport(config.transport);
      await client.connect(transport);

      const { tools: mcpTools } = await client.listTools();
      for (const mcpTool of mcpTools) {
        if (
          config.allowedTools &&
          !config.allowedTools.includes(mcpTool.name)
        ) {
          continue;
        }

        if (!NAMESPACE_RE.test(mcpTool.name)) {
          throw new TypeError(
            `MCP server "${config.name}" exposes tool "${mcpTool.name}" which does not match ${NAMESPACE_RE} — names containing "__" or other unsafe characters would collide in the namespaced tool set.`,
          );
        }

        const toolName = namespacedToolName(config.name, mcpTool.name);
        if (toolName in tools) {
          throw new TypeError(
            `MCP tool name collision for "${toolName}" (server "${config.name}", tool "${mcpTool.name}"). A tool with this namespaced name is already registered.`,
          );
        }
        toolOrigins[toolName] = config.name;

        const schema = jsonSchema(
          (mcpTool.inputSchema ?? {
            type: 'object',
            properties: {},
          }) as Parameters<typeof jsonSchema>[0],
        );

        tools[toolName] = dynamicTool({
          description:
            mcpTool.description ??
            `MCP tool "${mcpTool.name}" from server "${config.name}".`,
          inputSchema: schema,
          execute: async (args: unknown) => {
            if (closed) {
              return `Error: MCP server "${config.name}" is closed.`;
            }
            try {
              const result = await client.callTool({
                name: mcpTool.name,
                arguments: (args ?? {}) as Record<string, unknown>,
              });
              const body = formatMcpToolResult(result);
              return wrapForModel(body, {
                tool: toolName,
                path: `${config.name}:${mcpTool.name}`,
              }).content;
            } catch (error) {
              const msg =
                error instanceof Error ? error.message : String(error);
              return `Error calling ${toolName}: ${msg}`;
            }
          },
        });
      }
    }
  } catch (error) {
    await closeAll();
    throw error;
  }

  return {
    tools,
    toolOrigins,
    close: closeAll,
  };
}

export function createTransport(config: McpTransportConfig): Transport {
  switch (config.type) {
    case 'stdio':
      if (stdioTransportFactory) {
        return stdioTransportFactory(config);
      }
      throw new Error('stdio transport is not supported in browser environment');
    case 'sse':
      return new SSEClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      });
    case 'http':
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      });
  }
}

/**
 * Render an MCP tool result into the string shape agent-do's loop expects.
 */
function formatMcpToolResult(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return typeof result === 'string' ? result : JSON.stringify(result);
  }
  const parts: string[] = [];
  for (const part of content as Array<Record<string, unknown>>) {
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text);
    } else if (part.type === 'image') {
      parts.push(`[image: ${part.mimeType ?? 'unknown'}]`);
    } else if (part.type === 'resource') {
      const uri =
        (part.resource as { uri?: string } | undefined)?.uri ?? 'unknown';
      parts.push(`[resource: ${uri}]`);
    } else {
      parts.push(`[${part.type ?? 'unknown'} part]`);
    }
  }
  const body = parts.join('\n');
  if ((result as { isError?: boolean }).isError) {
    return `Tool error: ${body}`;
  }
  return body;
}
