import { describe, it, expect } from 'vitest';
import { streamAgentLoop } from '../src/loop.js';
import { createMockModel } from '../src/testing/index.js';
import { tool } from 'ai';
import { z } from 'zod';
import type { AgentConfig, ProgressEvent } from '../src/types.js';
import type { ToolResult } from '../src/tools/types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const s = (schema: z.ZodType): any => schema;

function mockModel(...args: Parameters<typeof createMockModel>): AgentConfig['model'] {
  return createMockModel(...args) as unknown as AgentConfig['model'];
}

async function collect(
  config: AgentConfig,
  task = 'Go',
): Promise<ProgressEvent[]> {
  const events: ProgressEvent[] = [];
  for await (const event of streamAgentLoop(config, task)) {
    events.push(event);
  }
  return events;
}

describe('Stream enrichment with ToolResult (#48 stage 1)', () => {
  it('carries summary/data from a structured tool through the stream', async () => {
    const richResult: ToolResult = {
      modelContent: 'Read 42 bytes from notes.md',
      userSummary: '[read_file] notes.md — 42 bytes, 3 lines',
      data: { path: 'notes.md', bytes: 42, lines: 3 },
    };

    const config: AgentConfig = {
      id: 't',
      name: 'T',
      model: mockModel({
        responses: [
          { toolCalls: [{ toolName: 'read_file', args: { path: 'notes.md' } }] },
          { text: 'Done.' },
        ],
      }),
      tools: {
        read_file: tool({
          description: 'Read',
          inputSchema: s(z.object({ path: z.string() })),
          execute: async () => richResult,
        }),
      },
      maxIterations: 3,
    };

    const events = await collect(config);
    const result = events.find((e) => e.type === 'tool-result');
    expect(result).toBeDefined();
    expect(result?.summary).toBe('[read_file] notes.md — 42 bytes, 3 lines');
    expect(result?.data).toEqual({ path: 'notes.md', bytes: 42, lines: 3 });
    // Default: no raw tool result leaked.
    expect(result?.toolResult).toBeUndefined();
  });

  it('does not leak full ToolResult by default', async () => {
    const secret: ToolResult = {
      modelContent: 'stub',
      userSummary: '[read_file] stub',
      data: { secretValue: 'AKIASEC' },
    };
    const config: AgentConfig = {
      id: 't',
      name: 'T',
      model: mockModel({
        responses: [
          { toolCalls: [{ toolName: 'read_file', args: { path: 'x' } }] },
          { text: 'Done.' },
        ],
      }),
      tools: {
        read_file: tool({
          description: 'Read',
          inputSchema: s(z.object({ path: z.string() })),
          execute: async () => secret,
        }),
      },
      maxIterations: 3,
    };
    const events = await collect(config);
    const result = events.find((e) => e.type === 'tool-result');
    expect(result?.toolResult).toBeUndefined();
  });

  it('emits full ToolResult when emitFullResult is true', async () => {
    const rich: ToolResult = {
      modelContent: 'short',
      userSummary: '[x] short',
      data: { foo: 'bar' },
    };
    const config: AgentConfig = {
      id: 't',
      name: 'T',
      model: mockModel({
        responses: [
          { toolCalls: [{ toolName: 'read_file', args: { path: 'x' } }] },
          { text: 'Done.' },
        ],
      }),
      tools: {
        read_file: tool({
          description: 'Read',
          inputSchema: s(z.object({ path: z.string() })),
          execute: async () => rich,
        }),
      },
      emitFullResult: true,
      maxIterations: 3,
    };
    const events = await collect(config);
    const result = events.find((e) => e.type === 'tool-result');
    expect(result?.toolResult).toEqual(rich);
  });

  it('normalises plain-string tool returns into summary', async () => {
    const config: AgentConfig = {
      id: 't',
      name: 'T',
      model: mockModel({
        responses: [
          { toolCalls: [{ toolName: 'echo_tool', args: { msg: 'hi' } }] },
          { text: 'Done.' },
        ],
      }),
      tools: {
        echo_tool: tool({
          description: 'Echo',
          inputSchema: s(z.object({ msg: z.string() })),
          execute: async ({ msg }) => `echoed: ${msg}`,
        }),
      },
      maxIterations: 3,
    };
    const events = await collect(config);
    const result = events.find((e) => e.type === 'tool-result');
    // Strings flow through normaliseToolResult so summary === modelContent.
    expect(result?.summary).toBe('echoed: hi');
  });

  it('surfaces blocked flag when the permission layer denies a tool', async () => {
    const config: AgentConfig = {
      id: 't',
      name: 'T',
      model: mockModel({
        responses: [
          { toolCalls: [{ toolName: 'tool_x', args: {} }] },
          { text: 'Done.' },
        ],
      }),
      tools: {
        tool_x: tool({
          description: 'X',
          inputSchema: s(z.object({})),
          execute: async () => 'should not reach',
        }),
      },
      permissions: { mode: 'deny-all' },
      maxIterations: 3,
    };
    const events = await collect(config);
    const result = events.find((e) => e.type === 'tool-result');
    expect(result?.blocked).toBe(true);
    expect(result?.data).toMatchObject({ reason: 'permission-denied' });
  });
});
