/**
 * MCP (Model Context Protocol) server mounting.
 *
 * Spawns / connects to MCP servers, lists their tools, and wraps each one
 * as a Vercel AI SDK dynamic tool so the agent loop can invoke them
 * alongside local tools (and hooks / permissions / usage tracking apply
 * uniformly). See issue #75.
 *
 * Design choices:
 *   - Tools are namespaced as `mcp__<server>__<tool>` so two servers
 *     exposing a same-named tool don't collide.
 *   - Each tool uses `dynamicTool` + `jsonSchema(...)` so we can plumb
 *     through the server's declared input schema without a compile-time
 *     zod round-trip.
 *   - `mountMcpServers` is all-or-nothing: if any server fails to connect,
 *     previously-connected servers are closed before the error propagates.
 *     Half-mounted state is a footgun that's hard to reason about in the
 *     agent loop's shutdown path.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { dynamicTool, jsonSchema, type ToolSet } from 'ai';

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
 * Result of {@link mountMcpServers}. `tools` is a {@link ToolSet} that
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

const NAMESPACE_RE = /^[a-zA-Z0-9_-]+$/;
/** Prefix applied to every MCP-sourced tool name. Also used by loop.ts for logging. */
export const MCP_TOOL_PREFIX = 'mcp__';

/**
 * Build the namespaced tool name. Exported so tests and debug output can
 * reuse the convention without re-deriving it.
 */
export function namespacedToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}__${toolName}`;
}

/**
 * Connect to each MCP server in `configs`, list their tools, and return
 * them merged as a single {@link ToolSet}.
 *
 * Lifecycle contract:
 *   - All-or-nothing: if any server's `connect()` or `listTools()` throws,
 *     previously-connected servers are closed before the error propagates.
 *   - The returned `close()` is idempotent; calling it twice is a no-op.
 *   - Tools invoked after `close()` resolve with an error string rather
 *     than throwing (same shape as other execute errors in agent-do).
 */
export async function mountMcpServers(
  configs: McpServerConfig[],
): Promise<MountedMcpServers> {
  // Validate up front — surface bad names as TypeErrors before any
  // subprocess spawns, so the caller gets a deterministic failure.
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
    // Close in reverse mount order — if a server depends on a shared
    // resource owned by an earlier one, this minimises the chance
    // of partial-shutdown noise.
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
        version: '0.2.0',
      });

      const transport = createTransport(config.transport);
      await client.connect(transport);
      clients.push(client);

      const { tools: mcpTools } = await client.listTools();
      for (const mcpTool of mcpTools) {
        if (
          config.allowedTools &&
          !config.allowedTools.includes(mcpTool.name)
        ) {
          continue;
        }

        const toolName = namespacedToolName(config.name, mcpTool.name);
        toolOrigins[toolName] = config.name;

        // Dynamic tool: schema is not known at compile time, so we route
        // through `jsonSchema()` to get a Schema the AI SDK can pass to
        // providers. `additionalProperties: false` defaults aren't
        // trusted here — the server owns the contract.
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
              return formatMcpToolResult(result);
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

function createTransport(config: McpTransportConfig) {
  switch (config.type) {
    case 'stdio':
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
        cwd: config.cwd,
      });
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
 * Render an MCP tool result into the string shape agent-do's loop
 * expects. MCP tools can return mixed content (text, images, embedded
 * resources); today we flatten to text concatenation. Non-text parts
 * get a short descriptor so the model at least knows something else
 * came back.
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
