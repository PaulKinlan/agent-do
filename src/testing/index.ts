/**
 * Testing utilities for agent-do.
 *
 * Provides a createMockModel that wraps the AI SDK's MockLanguageModelV4
 * with a simpler interface for predetermined responses.
 */

import {
  MockLanguageModelV4,
  convertArrayToReadableStream,
} from 'ai/test';

export interface MockResponse {
  text?: string;
  toolCalls?: Array<{
    toolName: string;
    args: Record<string, unknown>;
    /** Emit as a provider-executed (server-side) call (agent-do-cgh). */
    providerExecuted?: boolean;
  }>;
  /**
   * Server-side results for provider-executed calls, paired with the
   * `providerExecuted` tool calls by tool name (agent-do-cgh). Emitted as
   * raw `tool-result` stream/content parts like real provider streams do.
   * `isError: true` mirrors providers' error results — the SDK surfaces
   * those as `tool-error` parts.
   */
  providerToolResults?: Array<{
    toolName: string;
    result: unknown;
    isError?: boolean;
  }>;
}

export interface MockModelOptions {
  /** Predetermined responses. response[0] for call 1, response[1] for call 2, etc. */
  responses: MockResponse[];
  /** Model ID for logging. Defaults to 'mock-model'. */
  modelId?: string;
  /** Provider name for logging. Defaults to 'mock-provider'. */
  provider?: string;
  /** Simulated input tokens per call. Defaults to 10. */
  inputTokensPerCall?: number;
  /** Simulated output tokens per call. Defaults to 20. */
  outputTokensPerCall?: number;
}

/**
 * V4 finish reasons are `{ unified, raw }`, not the flat string the retired V3 spec used. Getting this
 * wrong is silent rather than loud: the SDK's tool-execution gate reads `finishReason.unified`, so a flat
 * string leaves it undefined, `isToolExecutionAllowedFinishReason()` returns false, and the tool calls the
 * model just reported are never executed. The loop then feeds that unexecuted call back as history and the
 * SDK rejects it with MissingToolResultsError (agent-do-5jv).
 */
function mockFinishReason(response: MockResponse) {
  return {
    unified: response?.toolCalls?.length ? 'tool-calls' : 'stop',
    raw: undefined,
  };
}

/** V4 usage is nested per direction (`{total, noCache, …}`), not the flat `{inputTokens, outputTokens}`. */
function mockUsage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
  };
}

function buildStreamParts(
  response: MockResponse,
  callIndex: number,
  inputTokens: number,
  outputTokens: number,
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];

  // Stream start
  parts.push({ type: 'stream-start', warnings: [] });

  // Response metadata
  parts.push({
    type: 'response-metadata',
    id: `resp-${callIndex}`,
    timestamp: new Date(),
    modelId: 'mock-model',
  });

  if (response?.text) {
    const textId = `text-${callIndex}`;
    parts.push({ type: 'text-start', id: textId });
    parts.push({ type: 'text-delta', id: textId, delta: response.text });
    parts.push({ type: 'text-end', id: textId });
  }

  if (response?.toolCalls) {
    for (const tc of response.toolCalls) {
      const toolId = `call-${callIndex}-${tc.toolName}`;
      parts.push({
        type: 'tool-input-start',
        id: toolId,
        toolName: tc.toolName,
        ...(tc.providerExecuted ? { providerExecuted: true } : {}),
      });
      parts.push({
        type: 'tool-input-delta',
        id: toolId,
        delta: JSON.stringify(tc.args),
      });
      parts.push({ type: 'tool-input-end', id: toolId });
      // Emit the resolved tool-call (same as real providers do after input streaming)
      parts.push({
        type: 'tool-call',
        toolCallId: toolId,
        toolName: tc.toolName,
        input: JSON.stringify(tc.args),
        ...(tc.providerExecuted ? { providerExecuted: true } : {}),
      });
    }
    // Server-side results for provider-executed calls — the provider runs
    // the tool and streams the result back, so the model stream itself
    // carries the `tool-result` (agent-do-cgh).
    if (response.providerToolResults) {
      for (const tr of response.providerToolResults) {
        parts.push({
          type: 'tool-result',
          toolCallId: `call-${callIndex}-${tr.toolName}`,
          toolName: tr.toolName,
          result: tr.result,
          ...(tr.isError ? { isError: true } : {}),
        });
      }
    }
  }

  parts.push({
    type: 'finish',
    finishReason: mockFinishReason(response),
    usage: mockUsage(inputTokens, outputTokens),
  });

  return parts;
}

function buildGenerateContent(
  response: MockResponse,
  callIndex: number,
): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];

  if (response?.text) {
    content.push({ type: 'text', text: response.text });
  }

  if (response?.toolCalls) {
    for (const tc of response.toolCalls) {
      content.push({
        type: 'tool-call',
        toolCallId: `call-${callIndex}-${tc.toolName}`,
        toolName: tc.toolName,
        input: JSON.stringify(tc.args),
        ...(tc.providerExecuted ? { providerExecuted: true } : {}),
      });
    }
    if (response.providerToolResults) {
      for (const tr of response.providerToolResults) {
        content.push({
          type: 'tool-result',
          toolCallId: `call-${callIndex}-${tr.toolName}`,
          toolName: tr.toolName,
          output: tr.result,
          providerExecuted: true,
          ...(tr.isError ? { isError: true } : {}),
        });
      }
    }
  }

  return content;
}

/**
 * Create a mock LanguageModel that returns predetermined responses.
 * Works with both streamText() and generateText() from the Vercel AI SDK.
 *
 * Uses the AI SDK's built-in MockLanguageModelV4. If a model is left on the
 * retired V3 spec, the SDK no longer runs the tools it reports (the step loop
 * returns the call with zero results), and the loop then feeds that unexecuted
 * call back as history - which the SDK rejects with MissingToolResultsError.
 */
export function createMockModel(options: MockModelOptions) {
  let callIndex = 0;
  const modelId = options.modelId ?? 'mock-model';
  const provider = options.provider ?? 'mock-provider';
  const inputTokens = options.inputTokensPerCall ?? 10;
  const outputTokens = options.outputTokensPerCall ?? 20;

  return new MockLanguageModelV4({
    provider,
    modelId,
    doGenerate: async () => {
      const responseIndex = Math.min(
        callIndex,
        options.responses.length - 1,
      );
      const response = options.responses[responseIndex];
      callIndex++;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return {
        content: buildGenerateContent(response, callIndex),
        finishReason: mockFinishReason(response),
        usage: mockUsage(inputTokens, outputTokens),
        warnings: [],
      } as any;
    },
    doStream: async () => {
      const responseIndex = Math.min(
        callIndex,
        options.responses.length - 1,
      );
      const response = options.responses[responseIndex];
      callIndex++;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return {
        stream: convertArrayToReadableStream(
          buildStreamParts(
            response,
            callIndex,
            inputTokens,
            outputTokens,
          ) as any[],
        ),
      } as any;
    },
  });
}
