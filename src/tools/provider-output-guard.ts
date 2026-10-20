/**
 * Content guard for provider-native tool results (agent-do-7hu).
 *
 * Provider packages ship *provider-executed* tools — Google `googleSearch` /
 * `urlContext`, Anthropic `webSearch_*` / `webFetch_*`, OpenAI `webSearch` —
 * whose results the provider produces server-side and hands back as a
 * tool-result part. Those results carry arbitrary third-party web content
 * straight into the model's context, and until this module they were the one
 * tool surface that skipped the guards every other tool goes through:
 * `file-tools`, `workspace-tools`, `memory-tools`, `shell-tool`, MCP and the
 * orchestrator all pass their output through `wrapForModel()`
 * (`tools/content-guards.ts`), which frames it in `<tool_output>` boundary tags,
 * redacts injection markers and caps the size.
 *
 * ## Why this module does not simply call `wrapForModel`
 *
 * `wrapForModel` returns one wrapped *string*. A provider tool result is not a
 * string: the AI SDK hands the provider's raw payload to the tool's
 * `toModelOutput()` hook and the provider package then converts that output back
 * into the provider's own protocol shape on the next request
 * (`@ai-sdk/anthropic` validates it against the tool's `outputSchema` and
 * *drops* the result — breaking the `tool_use` / `tool_result` pairing — when
 * the shape does not match). Rewriting a web-search payload into a
 * `<tool_output>` string would therefore break replay on those providers, and
 * dropping or truncating inside a payload can corrupt fields the provider
 * treats as opaque (Anthropic's `encryptedContent`, a fetch result's base64
 * document source).
 *
 * So the guard applies, per output kind:
 *
 *   - **text** — framed and capped exactly like every other tool result, via
 *     `wrapForModel`. Nothing provider-shaped is lost: a text tool result HAS
 *     no provider structure, and the providers that require a structured
 *     payload already refuse a text result on their own.
 *   - **json** — walked recursively; every string leaf gets the same two
 *     transforms as `wrapForModel` (boundary tags escaped, injection markers
 *     redacted) while keys, types and structure are preserved, so the payload
 *     still satisfies the provider's `outputSchema`. Byte caps are deliberately
 *     NOT applied to json payloads for the same reason (a capped
 *     `encryptedContent` or a half-base64 document is worse than a long one);
 *     provider-side limits already bound these payloads.
 *
 * What this does not do: it cannot frame content the provider synthesises into
 * its *own* assistant text (grounded answers and citations arrive as text
 * parts, not tool results), and it does not make an unframed payload safe for
 * a provider that would reject a frame. Both are recorded in
 * `docs/security.md` rather than papered over.
 */

import { wrapForModel, sanitiseUntrustedText } from './content-guards.js';

/**
 * The shape the AI SDK's `toModelOutput()` hook must return. Declared
 * structurally here rather than imported: the repo does not depend on
 * `@ai-sdk/provider-utils` directly, and only these five variants matter to the
 * guard.
 */
export type ModelToolOutput =
  | { type: 'text'; value: string }
  | { type: 'json'; value: unknown }
  | { type: 'error-text'; value: string }
  | { type: 'error-json'; value: unknown }
  | { type: 'content'; value: ReadonlyArray<unknown> }
  | { type: 'execution-denied'; reason?: string };

export interface ProviderOutputGuardOptions {
  /** Tool key the result came from (`google__googleSearch`, `web_search`, …). */
  tool: string;
  /** Optional cap for text payloads; defaults to `DEFAULT_MAX_READ_BYTES`. */
  maxBytes?: number;
}

/**
 * Value echoed in the boundary marker's `source` attribute. The tool key is
 * already in `tool="…"`; this says *why* there is no path or command.
 */
export const PROVIDER_OUTPUT_SOURCE = 'provider-native';

/**
 * Guard a provider-native tool result *before* the provider SDK converts it
 * into its wire format.
 *
 * Provider results arrive as raw JSON values (a string, an object, an array).
 * A string is treated as the result text and framed; everything else is walked
 * as JSON, which is what the AI SDK's default mapping (`{ type: 'json', … }`)
 * would have done with it anyway.
 */
export function sanitiseProviderToolOutput(
  raw: unknown,
  opts: ProviderOutputGuardOptions,
): ModelToolOutput {
  if (typeof raw === 'string') {
    return {
      type: 'text',
      value: wrapForModel(raw, {
        tool: opts.tool,
        source: PROVIDER_OUTPUT_SOURCE,
        ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
      }).content,
    };
  }

  return {
    type: 'json',
    value: sanitiseUntrustedJson(raw === undefined ? null : raw),
  };
}

/**
 * Guard an already-mapped tool output — used when the provider SDK (or a
 * script export) supplied its own `toModelOutput()` and we chain after it.
 *
 * `content` parts are walked string-by-string without extra framing: each part
 * belongs to a provider-shaped array whose element types the provider may
 * check.
 */
export function sanitiseMappedProviderOutput(
  output: ModelToolOutput,
  opts: ProviderOutputGuardOptions,
): ModelToolOutput {
  switch (output.type) {
    case 'text':
      return {
        type: 'text',
        value: wrapForModel(output.value, {
          tool: opts.tool,
          source: PROVIDER_OUTPUT_SOURCE,
          ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
        }).content,
      };
    case 'json':
    case 'error-json':
      return { ...output, value: sanitiseUntrustedJson(output.value) };
    case 'error-text':
      // Errors are provider-generated, but a rejection message can quote the
      // fetched page, so it gets the same two transforms (without framing).
      return { ...output, value: sanitiseUntrustedText(output.value).text };
    case 'content':
      return { ...output, value: sanitiseUntrustedJson(output.value) as ReadonlyArray<unknown> };
    default:
      // `execution-denied` and any future variant carry no third-party text.
      return output;
  }
}

/**
 * Recursively apply {@link sanitiseUntrustedText} to every string leaf of a
 * JSON value, preserving keys, value types, array/nesting structure and — when
 * nothing needed changing — the original reference.
 *
 * Structural sharing (same contract as `loop-history.ts`) keeps "did the guard
 * alter anything" answerable by reference and avoids rebuilding payloads that
 * contain no untrusted-looking text at all.
 */
export function sanitiseUntrustedJson(value: unknown): unknown {
  if (typeof value === 'string') {
    const { text } = sanitiseUntrustedText(value);
    return text === value ? value : text;
  }

  if (Array.isArray(value)) {
    let changed = false;
    const out = new Array<unknown>(value.length);
    for (let i = 0; i < value.length; i++) {
      const next = sanitiseUntrustedJson(value[i]);
      if (next !== value[i]) changed = true;
      out[i] = next;
    }
    return changed ? out : value;
  }

  if (value !== null && typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const next = sanitiseUntrustedJson(v);
      if (next !== v) changed = true;
      // defineProperty, not assignment: a payload key named `__proto__` would
      // otherwise run Object.prototype's setter instead of creating a property.
      Object.defineProperty(out, k, {
        value: next,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return changed ? out : value;
  }

  return value;
}
