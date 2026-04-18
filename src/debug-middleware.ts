/**
 * Debug middleware (#72).
 *
 * Wraps `AgentConfig.model` via the AI SDK's `wrapLanguageModel`
 * surface so the loop can see the raw params going to the provider
 * (messages, system prompt, tools, providerOptions) and the raw
 * stream parts coming back (text-delta, tool-call, finish, etc.).
 *
 * Deliberately passive: the middleware only observes — no mutation,
 * no retry, no short-circuit. Emission happens through the `emit`
 * callback the loop wires in, which funnels into the progress
 * stream (`type: 'debug'`) and the caller's `debug.sink` in one go.
 *
 * The middleware needs to know which outer iteration is running so
 * debug events can be correlated to progress events. The loop
 * mutates a shared `stepRef.current` before each `streamText` call;
 * middleware reads it when a request goes out or a part comes back.
 *
 * Web compatibility: this file uses `TextEncoder` / `TextDecoder`
 * (universal in browsers and Node ≥ 18) instead of Node's `Buffer`,
 * so the debug surface works unchanged in a browser-OPFS MemoryStore
 * path too. (#72 review)
 */

import type {
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import type { ModelMessage } from 'ai';
import type { DebugConfig, DebugEvent } from './types.js';

/** Mutable step counter shared between the loop and the middleware. */
export interface StepRef {
  current: number;
}

/**
 * Default body-size cap for system-prompt / messages debug payloads.
 * 16 KB is large enough that real prompts almost always fit, but small
 * enough that an accidental megabyte dump doesn't wedge a terminal.
 */
const DEFAULT_MAX_BODY_BYTES = 16 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Count the UTF-8 byte length of a string without allocating
 * intermediate strings — used for size caps throughout the debug
 * surface so non-ASCII content is measured correctly.
 */
function utf8ByteLength(s: string): number {
  return encoder.encode(s).byteLength;
}

/**
 * Truncate `content` to at most `maxBytes` UTF-8 bytes **respecting
 * character boundaries**. A naive `content.slice(0, maxBytes)` is
 * wrong for two reasons: `slice` counts UTF-16 code units (not
 * bytes), and even a byte-level cut can land mid-character and
 * produce invalid UTF-8. This encodes to a byte view, rolls back
 * past any continuation bytes, and decodes the prefix.
 *
 * Returns just the truncated prefix; callers append their own
 * "truncated N bytes" marker.
 */
function truncateUtf8ByBytes(content: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = encoder.encode(content);
  if (bytes.byteLength <= maxBytes) return content;
  // Roll back past any UTF-8 continuation bytes (bits `10xxxxxx`,
  // i.e. byte & 0xc0 === 0x80) so the cut lands on a character
  // boundary. Worst case we back up 3 bytes (4-byte UTF-8 sequences).
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}

export function createDebugMiddleware(
  debug: DebugConfig,
  emit: (event: DebugEvent) => void,
  stepRef: StepRef,
): LanguageModelV3Middleware {
  const wantMessages = debug.all || debug.messages;
  const wantRequest = debug.all || debug.request;
  // `response` follows `all: true` — library users who ask for
  // everything get the per-part stream too. The CLI maps
  // `--log-level debug` to an explicit channel map that leaves
  // `response: false` so operators don't pay the per-token
  // middleware cost unless they bump to `trace`. See
  // `src/cli/debug-config.ts`.
  const wantResponse = debug.all || debug.response === true;
  const traceParts = debug.traceResponseParts === true;
  const maxBodyBytes = debug.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return {
    specificationVersion: 'v3',
    transformParams: async ({ params, model }) => {
      if (wantMessages) {
        const { messages, bytes, truncated } = clampMessages(
          params.prompt as ModelMessage[],
          maxBodyBytes,
        );
        emit({
          channel: 'messages',
          step: stepRef.current,
          messages,
          bytes,
          truncated,
        });
      }
      if (wantRequest) {
        const tools = params.tools ?? [];
        emit({
          channel: 'request',
          step: stepRef.current,
          model: model.modelId,
          toolCount: tools.length,
          toolNames: tools.map((t) => (t as { name?: string }).name ?? '(unnamed)'),
          providerOptions: params.providerOptions as Record<string, unknown> | undefined,
        });
      }
      return params;
    },

    wrapStream: async ({ doStream }) => {
      const result = await doStream();
      if (!wantResponse) return result;

      const step = stepRef.current;
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
            transform(part, controller) {
              emit({
                channel: 'response-part',
                step,
                partType: part.type,
                part: traceParts
                  ? (part as unknown as Record<string, unknown>)
                  : undefined,
              });
              controller.enqueue(part);
            },
          }),
        ),
      };
    },
  };
}

/**
 * Truncate the message list's bodies so the debug payload stays
 * bounded. We keep the message *shapes* (role + content structure)
 * and only clip the string contents that exceed the cap, so logs
 * still show the conversation flow even when individual messages are
 * huge.
 */
function clampMessages(
  messages: ModelMessage[],
  maxBodyBytes: number,
): { messages: ModelMessage[]; bytes: number; truncated: boolean } {
  let truncated = false;
  let totalBytes = 0;

  const clamped = messages.map((msg) => {
    if (typeof msg.content === 'string') {
      const bytes = utf8ByteLength(msg.content);
      totalBytes += bytes;
      if (bytes > maxBodyBytes) {
        truncated = true;
        return {
          ...msg,
          content:
            truncateUtf8ByBytes(msg.content, maxBodyBytes) +
            `\n[… truncated ${bytes - maxBodyBytes} bytes]`,
        };
      }
      return msg;
    }
    if (Array.isArray(msg.content)) {
      const parts = (msg.content as unknown[]).map((p) => {
        if (
          typeof p === 'object' &&
          p !== null &&
          'text' in p &&
          typeof (p as { text: unknown }).text === 'string'
        ) {
          const pt = p as { text: string };
          const bytes = utf8ByteLength(pt.text);
          totalBytes += bytes;
          if (bytes > maxBodyBytes) {
            truncated = true;
            // Spread the ORIGINAL part object, not the narrowed
            // `{ text: string }` view — otherwise we'd drop
            // `type`, `toolName`, ids, etc. from the debug payload
            // and lose the shape the operator is trying to inspect.
            // (Copilot #73)
            return {
              ...(p as Record<string, unknown>),
              text:
                truncateUtf8ByBytes(pt.text, maxBodyBytes) +
                `\n[… truncated ${bytes - maxBodyBytes} bytes]`,
            };
          }
        }
        return p;
      });
      return { ...msg, content: parts } as ModelMessage;
    }
    return msg;
  });

  return { messages: clamped as ModelMessage[], bytes: totalBytes, truncated };
}

/**
 * Split a step's raw usage into the channels the `cache` debug event
 * surfaces. Exported separately so `buildOnStepFinish` can use it
 * without needing to import the middleware.
 *
 * Anthropic's cache metrics surface via
 * `usage.inputTokenDetails.cacheReadTokens` / `cacheWriteTokens` per
 * the AI SDK v6 `LanguageModelUsage` shape. Older deprecated shapes
 * (`cachedInputTokens`) are accepted as a fallback so the extractor
 * works against mock usage objects too.
 */
export function extractCacheUsage(usage: unknown): {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  noCacheTokens: number;
  outputTokens: number;
} {
  const u = (usage ?? {}) as {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    inputTokenDetails?: {
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      noCacheTokens?: number;
    };
  };
  const details = u.inputTokenDetails ?? {};
  const cacheReadTokens = details.cacheReadTokens ?? u.cachedInputTokens ?? 0;
  const cacheWriteTokens = details.cacheWriteTokens ?? 0;
  // Prefer the detail field when present; otherwise back-compute from
  // the flat inputTokens minus the reads we know about.
  const noCacheTokens =
    details.noCacheTokens ?? Math.max(0, (u.inputTokens ?? 0) - cacheReadTokens);
  return {
    cacheReadTokens,
    cacheWriteTokens,
    noCacheTokens,
    outputTokens: u.outputTokens ?? 0,
  };
}

/**
 * Clip a string to `maxBytes` UTF-8 bytes. Used for the system-prompt
 * channel where we only have a string (not structured messages).
 * Character-boundary-safe — see `truncateUtf8ByBytes`.
 */
export function clampString(
  content: string,
  maxBytes: number,
): { content: string; bytes: number; truncated: boolean } {
  const bytes = utf8ByteLength(content);
  if (bytes <= maxBytes) return { content, bytes, truncated: false };
  return {
    content:
      truncateUtf8ByBytes(content, maxBytes) +
      `\n[… truncated ${bytes - maxBytes} bytes]`,
    bytes,
    truncated: true,
  };
}
