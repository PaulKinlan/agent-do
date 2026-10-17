/** Lazy, anonymous web tools for fresh CLI prompt sessions. */
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { ParsedArgs } from './args.js';
import { wrapForModel } from '../tools/content-guards.js';
import type { ToolResult } from '../tools/types.js';

const VERSION = '0.7.0';
const ENDPOINT = 'https://search.parallel.ai/mcp';
const TIMEOUT_MS = 30_000;
const searchInput = z.object({
  objective: z.string().min(1),
  search_queries: z.array(z.string().min(1)).min(1),
});
const fetchInput = z.object({
  urls: z.array(z.url().refine(url => ['http:', 'https:'].includes(new URL(url).protocol),
    'Only HTTP and HTTPS URLs are supported')).min(1).max(20),
  objective: z.string().max(200).optional(),
});

/**
 * Only the unconfigured prompt path gets a search default. Saved agents,
 * scripts and library users keep their own tool maps; explicit provider
 * tools/options are authoritative. Creation is network-free so the normal
 * tool permission and pre-tool hook checks run before even MCP discovery.
 */
export function buildPromptSearchTools(args: ParsedArgs, modelId?: string): ToolSet {
  if (args.command !== 'prompt' || args.noTools || args.noSearch ||
      args.providerTool.length > 0 || args.providerOptions !== undefined) return {};

  // One identity per CLI conversation, shared by search and fetch, including
  // concurrent calls. Never read ambient search credentials or rotate on errors.
  const sessionId = randomUUID();
  const invoke = async (
    name: 'web_search' | 'web_fetch',
    input: unknown,
    abortSignal?: AbortSignal,
  ): Promise<ToolResult> => {
    const toolName = `mcp__parallel__${name}`;
    let client: Client | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new AbortController();
    const signal = abortSignal
      ? AbortSignal.any([abortSignal, timeout.signal])
      : timeout.signal;
    const result = (body: string, error: boolean): ToolResult => {
      const wrapped = wrapForModel(body, { tool: toolName, path: `parallel:${name}` });
      const { content, ...guards } = wrapped;
      return {
        modelContent: content,
        userSummary: `[${toolName}] ${error ? 'failed' : 'completed'}`,
        data: { error, ...guards },
      };
    };
    try {
      // Validate again because onPreToolUse may modify the already parsed args.
      const parsed = (name === 'web_search' ? searchInput : fetchInput).parse(input);
      signal.throwIfAborted();
      timer = setTimeout(() => timeout.abort(new Error('Parallel search timed out after 30 seconds.')), TIMEOUT_MS);
      client = new Client({ name: 'agent-do', version: VERSION });
      const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
        requestInit: { headers: { 'User-Agent': `agent-do/${VERSION}` } },
        // Cover initialization, discovery and the call itself with the same
        // cancellation/deadline. Preserve the transport's own shutdown signal.
        fetch: (url, init) => fetch(url, {
          ...init,
          signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
        }),
      });
      const options = { signal, timeout: TIMEOUT_MS };
      await client.connect(transport, options);
      const { tools } = await client.listTools({}, options);
      if (!tools.some(candidate => candidate.name === name)) {
        throw new Error(`Parallel MCP does not expose ${name}.`);
      }
      const response = CallToolResultSchema.parse(await client.callTool({
        name,
        arguments: {
          ...parsed,
          session_id: sessionId,
          ...(modelId ? { model_name: modelId } : {}),
        },
      }, undefined, options));
      const body = response.content
        .filter(part => part.type === 'text')
        .map(part => part.text).join('\n');
      return result(response.isError ? `Tool error: ${body}` : body, response.isError === true);
    } catch (error) {
      const cause = signal.aborted ? signal.reason : error;
      const message = cause instanceof Error ? cause.message : String(cause);
      const status = cause instanceof StreamableHTTPError && cause.code ? ` (HTTP ${cause.code})` : '';
      return result(`Error calling ${toolName}${status}: ${message}`, true);
    } finally {
      if (timer) clearTimeout(timer);
      await client?.close().catch(() => { /* shutdown must not hide the result */ });
    }
  };

  return {
    mcp__parallel__web_search: tool({
      description: 'Search the web for current facts, documentation and sources using Parallel. Results include URLs and excerpts; answer from excerpts when sufficient.',
      inputSchema: searchInput,
      execute: (input, { abortSignal }) => invoke('web_search', input, abortSignal),
    }),
    mcp__parallel__web_fetch: tool({
      description: 'Read relevant excerpts from HTTP/HTTPS pages using Parallel. Use for a specific URL or when search excerpts are insufficient.',
      inputSchema: fetchInput,
      execute: (input, { abortSignal }) => invoke('web_fetch', input, abortSignal),
    }),
  };
}
