/**
 * The mock model exists so the loop's tests exercise real SDK behaviour, and the behaviour they lean on is
 * that a tool call reported by the mock is actually RUN by the SDK and fed back as a tool result.
 *
 * The guard is here because breaking it is silent. On the V4 model spec the SDK decides whether to execute
 * the tools a model call reported by reading `finishReason.unified`; a mock still emitting the retired V3
 * shape (a flat finish reason, flat usage) leaves that undefined, so the SDK skips execution with no error
 * at all and the mistake only surfaces later as `MissingToolResultsError` when the loop sends that
 * unexecuted call back as history. That cost 24 tests across 7 suites and blocked a lockfile regeneration
 * (agent-do-5jv). Asserting the behaviour here means the next bump of `ai` fails loudly and immediately.
 */
import { describe, expect, it } from 'vitest';
import { generateText, tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { createMockModel } from '../src/testing/index.js';

describe('createMockModel', () => {
  it('gets its tool calls executed by the SDK and fed back as a tool result', async () => {
    const executed: unknown[] = [];
    const model = createMockModel({
      responses: [
        { toolCalls: [{ toolName: 'my_tool', args: { input: 'test' } }] },
        { text: 'done' },
      ],
    });

    const result = await generateText({
      model: model as never,
      messages: [{ role: 'user', content: 'use the tool' }],
      tools: {
        my_tool: tool({
          description: 'A test tool',
          inputSchema: z.object({ input: z.string() }),
          execute: async (input) => {
            executed.push(input);
            return 'tool result';
          },
        }),
      },
      stopWhen: stepCountIs(5),
    });

    // The tool ran, with the arguments the mock reported...
    expect(executed).toEqual([{ input: 'test' }]);
    // ...the SDK carried on to the mock's second response instead of stopping at an unexecuted call...
    expect(result.steps).toHaveLength(2);
    expect(result.text).toBe('done');
    // ...and the first step holds the tool result that was fed back with the call.
    const firstStep = result.steps[0] as unknown as {
      content: Array<{ type: string }>;
      toolResults?: unknown[];
    };
    expect(firstStep.content.map((part) => part.type)).toContain('tool-call');
    expect(
      firstStep.content.some((part) => part.type === 'tool-result') ||
        (firstStep.toolResults?.length ?? 0) > 0,
    ).toBe(true);
  });
});
