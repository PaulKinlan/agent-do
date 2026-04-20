/**
 * Tests for MCP server mounting (#75).
 *
 * These tests exercise the tool-adapter logic without spinning real MCP
 * subprocesses: each test stubs the minimum client/transport surface,
 * then validates that `mountMcpServers` wires tools correctly and that
 * lifecycle (close, error-during-mount) behaves as advertised.
 *
 * For a real-subprocess smoke test, run `examples/14-mcp.ts` against
 * any official MCP server binary.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  namespacedToolName,
  MCP_TOOL_PREFIX,
} from '../src/mcp.js';

// Stub the MCP SDK's Client so we don't spawn subprocesses. Vitest's
// `vi.mock` rewires the ESM import — every `new Client(...)` in the
// module under test returns the stub instance configured below.
const stubClient = vi.hoisted(() => {
  type Tool = Record<string, unknown>;
  type ListToolsResult = { tools: Tool[] };
  type ContentPart = Record<string, unknown>;
  type CallToolResult = { content: ContentPart[]; isError?: boolean } | Record<string, unknown>;
  const state = {
    connect: vi.fn<(_: unknown) => Promise<void>>(async () => {}),
    listTools: vi.fn<() => Promise<ListToolsResult>>(async () => ({ tools: [] })),
    callTool: vi.fn<(_: unknown) => Promise<CallToolResult>>(async () => ({
      content: [{ type: 'text', text: 'stubbed' }],
    })),
    close: vi.fn<() => Promise<void>>(async () => {}),
  };
  return state;
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  function Client(this: unknown) {
    // Each `new Client(...)` returns the shared stub — tests run
    // sequentially so per-test mock state is isolated by `beforeEach`.
    Object.assign(this as object, stubClient);
  }
  return { Client };
});

// Transport stubs — just need to be constructable.
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  function StdioClientTransport() {}
  return { StdioClientTransport };
});
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => {
  function SSEClientTransport() {}
  return { SSEClientTransport };
});
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  function StreamableHTTPClientTransport() {}
  return { StreamableHTTPClientTransport };
});

// Import after mocks so the module resolves the stubs.
const { mountMcpServers } = await import('../src/mcp.js');

describe('namespacedToolName', () => {
  it('prefixes tool names with mcp__<server>__', () => {
    expect(namespacedToolName('gmail', 'send')).toBe('mcp__gmail__send');
    expect(namespacedToolName('calendar', 'list-events')).toBe(
      'mcp__calendar__list-events',
    );
  });

  it('exports a stable MCP_TOOL_PREFIX constant', () => {
    expect(MCP_TOOL_PREFIX).toBe('mcp__');
    expect(namespacedToolName('x', 'y').startsWith(MCP_TOOL_PREFIX)).toBe(
      true,
    );
  });
});

describe('mountMcpServers (#75)', () => {
  beforeEach(() => {
    stubClient.connect.mockClear();
    stubClient.listTools.mockClear();
    stubClient.callTool.mockClear();
    stubClient.close.mockClear();
    stubClient.listTools.mockResolvedValue({ tools: [] });
    stubClient.callTool.mockResolvedValue({
      content: [{ type: 'text', text: 'stubbed' }],
    });
  });

  it('rejects invalid server names', async () => {
    await expect(
      mountMcpServers([
        {
          name: 'bad name with spaces',
          transport: { type: 'stdio', command: 'noop' },
        },
      ]),
    ).rejects.toThrow(/must match/);
  });

  it('rejects duplicate server names', async () => {
    await expect(
      mountMcpServers([
        { name: 'fs', transport: { type: 'stdio', command: 'noop' } },
        { name: 'fs', transport: { type: 'stdio', command: 'noop' } },
      ]),
    ).rejects.toThrow(/Duplicate/);
  });

  it('namespaces discovered tools with mcp__<server>__<tool>', async () => {
    stubClient.listTools.mockResolvedValue({
      tools: [
        {
          name: 'read_file',
          description: 'Read a file',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
          },
        },
        {
          name: 'write_file',
          description: 'Write a file',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
          },
        },
      ],
    });

    const mounted = await mountMcpServers([
      { name: 'fs', transport: { type: 'stdio', command: 'noop' } },
    ]);

    expect(Object.keys(mounted.tools).sort()).toEqual([
      'mcp__fs__read_file',
      'mcp__fs__write_file',
    ]);
    expect(mounted.toolOrigins).toEqual({
      mcp__fs__read_file: 'fs',
      mcp__fs__write_file: 'fs',
    });

    await mounted.close();
  });

  it('invokes the MCP callTool with the bare (un-namespaced) name', async () => {
    stubClient.listTools.mockResolvedValue({
      tools: [
        {
          name: 'read_file',
          description: 'Read a file',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
          },
        },
      ],
    });

    const mounted = await mountMcpServers([
      { name: 'fs', transport: { type: 'stdio', command: 'noop' } },
    ]);

    const tool = mounted.tools.mcp__fs__read_file;
    // AI SDK tool execute signature is (input, toolCallOptions).
    const result = await tool.execute!({ path: '/tmp/foo' } as never, {
      toolCallId: 't1',
      messages: [],
    });

    expect(stubClient.callTool).toHaveBeenCalledWith({
      name: 'read_file',
      arguments: { path: '/tmp/foo' },
    });
    // MCP tool output is wrapped in `<tool_output>` markers so the
    // model treats it as untrusted data from a third-party server
    // (matches the file_tools / memory_tools convention).
    expect(result).toContain('<tool_output tool="mcp__fs__read_file" path="fs:read_file">');
    expect(result).toContain('stubbed');
    expect(result).toContain('</tool_output>');

    await mounted.close();
  });

  it('filters tools by allowedTools when set', async () => {
    stubClient.listTools.mockResolvedValue({
      tools: [
        { name: 'read', description: 'r', inputSchema: { type: 'object', properties: {} } },
        { name: 'write', description: 'w', inputSchema: { type: 'object', properties: {} } },
        { name: 'delete', description: 'd', inputSchema: { type: 'object', properties: {} } },
      ],
    });

    const mounted = await mountMcpServers([
      {
        name: 'fs',
        transport: { type: 'stdio', command: 'noop' },
        allowedTools: ['read', 'write'],
      },
    ]);

    expect(Object.keys(mounted.tools).sort()).toEqual([
      'mcp__fs__read',
      'mcp__fs__write',
    ]);

    await mounted.close();
  });

  it('flattens content parts into a single text string', async () => {
    stubClient.listTools.mockResolvedValue({
      tools: [{ name: 'echo', description: 'e', inputSchema: { type: 'object', properties: {} } }],
    });
    stubClient.callTool.mockResolvedValue({
      content: [
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' },
        { type: 'image', mimeType: 'image/png' },
      ],
    });

    const mounted = await mountMcpServers([
      { name: 'srv', transport: { type: 'stdio', command: 'noop' } },
    ]);
    const result = (await mounted.tools.mcp__srv__echo.execute!(
      {} as never,
      { toolCallId: 't', messages: [] },
    )) as string;

    expect(result).toContain('line one\nline two\n[image: image/png]');
    expect(result).toContain('<tool_output');
    expect(result).toContain('</tool_output>');
    await mounted.close();
  });

  it('surfaces error results with a "Tool error:" prefix', async () => {
    stubClient.listTools.mockResolvedValue({
      tools: [{ name: 'fail', description: 'f', inputSchema: { type: 'object', properties: {} } }],
    });
    stubClient.callTool.mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'permission denied' }],
    });

    const mounted = await mountMcpServers([
      { name: 'srv', transport: { type: 'stdio', command: 'noop' } },
    ]);
    const result = (await mounted.tools.mcp__srv__fail.execute!(
      {} as never,
      { toolCallId: 't', messages: [] },
    )) as string;

    // "Tool error:" sits inside the <tool_output> wrapper, not at the
    // very start of the string any more.
    expect(result).toContain('Tool error:');
    expect(result).toContain('permission denied');
    expect(result).toContain('<tool_output');
    await mounted.close();
  });

  it('returns an error string (not a throw) when the server callTool throws', async () => {
    stubClient.listTools.mockResolvedValue({
      tools: [{ name: 'flaky', description: 'f', inputSchema: { type: 'object', properties: {} } }],
    });
    stubClient.callTool.mockRejectedValue(new Error('connection reset'));

    const mounted = await mountMcpServers([
      { name: 'srv', transport: { type: 'stdio', command: 'noop' } },
    ]);
    const result = (await mounted.tools.mcp__srv__flaky.execute!(
      {} as never,
      { toolCallId: 't', messages: [] },
    )) as string;

    // The error path returns the raw error string (no <tool_output>
    // wrap) because wrapForModel is only applied on the success path.
    // It's a synthesised library message, not untrusted server content.
    expect(result).toMatch(/^Error calling mcp__srv__flaky:/);
    expect(result).toContain('connection reset');
    await mounted.close();
  });

  it('closes all clients on failed mount (all-or-nothing)', async () => {
    // First server connects fine, second throws. Both clients should be
    // closed — the first because it succeeded, the second because its
    // transport may have spawned a subprocess before `connect()` threw.
    // Copilot #75 review: clients must be tracked *before* connect() so
    // the failing client is included in the teardown list.
    let connectCount = 0;
    stubClient.connect.mockImplementation(async () => {
      connectCount++;
      if (connectCount === 2) {
        throw new Error('boom');
      }
    });

    await expect(
      mountMcpServers([
        { name: 'a', transport: { type: 'stdio', command: 'noop' } },
        { name: 'b', transport: { type: 'stdio', command: 'noop' } },
      ]),
    ).rejects.toThrow(/boom/);

    // The stub is shared, so every tracked Client's `close()` call
    // hits the same mock. With push-before-connect, both client-a
    // (successful) and client-b (failed mid-connect) are tracked,
    // and closeAll should call close on both.
    expect(stubClient.close).toHaveBeenCalledTimes(2);

    stubClient.connect.mockReset();
    stubClient.connect.mockResolvedValue(undefined);
  });

  it('rejects server names containing "__" to prevent tool-key collisions', async () => {
    await expect(
      mountMcpServers([
        { name: 'a__b', transport: { type: 'stdio', command: 'noop' } },
      ]),
    ).rejects.toThrow(/must match/);
  });

  it('rejects MCP tools whose names contain "__" (collision guard, Codex #75)', async () => {
    stubClient.listTools.mockResolvedValue({
      tools: [
        {
          name: 'ok_name',
          description: 'good',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'bad__name',
          description: 'ambiguous',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });

    await expect(
      mountMcpServers([
        { name: 'srv', transport: { type: 'stdio', command: 'noop' } },
      ]),
    ).rejects.toThrow(/match/);
  });

  it('close() is idempotent', async () => {
    stubClient.listTools.mockResolvedValue({ tools: [] });
    const mounted = await mountMcpServers([
      { name: 'srv', transport: { type: 'stdio', command: 'noop' } },
    ]);
    await mounted.close();
    await mounted.close(); // second close should be a no-op
    // Each connected client should be closed exactly once despite two
    // close() calls.
    expect(stubClient.close).toHaveBeenCalledTimes(1);
  });

  it('execute after close returns an error string', async () => {
    stubClient.listTools.mockResolvedValue({
      tools: [{ name: 'x', description: 'x', inputSchema: { type: 'object', properties: {} } }],
    });
    const mounted = await mountMcpServers([
      { name: 'srv', transport: { type: 'stdio', command: 'noop' } },
    ]);
    await mounted.close();

    const result = (await mounted.tools.mcp__srv__x.execute!(
      {} as never,
      { toolCallId: 't', messages: [] },
    )) as string;
    expect(result).toMatch(/closed/);
  });
});
