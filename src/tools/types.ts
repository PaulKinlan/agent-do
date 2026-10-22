/**
 * Structured tool results.
 *
 * Tools historically returned a single string that was fed simultaneously to
 * the model, the user's logs, and any programmatic consumer. Those three
 * audiences have incompatible needs (see issue #48):
 *
 * - the model needs short, bounded, sanitised content with no absolute paths;
 * - the operator wants rich diagnostics (paths, sizes, error codes);
 * - programmatic consumers want structured data they can render themselves.
 *
 * `ToolResult` makes the split explicit. A tool's `execute` function can
 * return a string (the old behaviour; normalised into both views) or a
 * `ToolResult` for full control.
 */

import { wrapForModel } from './content-guards.js';

/**
 * `source` attribute stamped on the `<tool_output>` frame when the guards wrap
 * a tool's own return value (agent-do-3qb) — the counterpart of
 * `PROVIDER_OUTPUT_SOURCE` in `provider-output-guard.ts`.
 */
export const TOOL_RETURN_SOURCE = 'tool-return';

export interface ToolResult {
  /**
   * What the model sees. Safe to include literal content from files, but the
   * tool is responsible for size caps, injection-marker redaction, and
   * stripping absolute paths.
   */
  modelContent: string;

  /**
   * A human-readable one-liner (or short multi-line) for operator logs.
   * May include absolute paths, real errno codes, byte counts, timing. Never
   * includes full file contents — those are carried in `data.content`.
   */
  userSummary: string;

  /**
   * Structured fields for programmatic consumers. Keys are tool-specific.
   * Conventions used by built-in tools:
   *   read_file  -> { path, bytes, lines, truncated, redactedMarkerCount }
   *   write_file -> { path, bytes, created }
   *   grep_file  -> { pattern, matchCount, fileCount }
   *   *blocked*  -> { blocked: true, reason, rule }
   *   *error*    -> { error: true, redactedMarkerCount, neutralisedDelimiterCount,
   *                   truncated, totalBytes }  (every MCP error path)
   *   *custom*   -> { guarded: true, truncated, redactedMarkerCount,
   *                   neutralisedDelimiterCount, totalBytes }  (a caller-registered
   *                   tool that returned a bare value instead of a ToolResult — see
   *                   normaliseToolResult)
   *
   * The two redaction counts are not synonyms and both are canonical:
   * `redactedMarkerCount` counts injection phrases redacted,
   * `neutralisedDelimiterCount` counts `<tool_output>` boundary tags escaped.
   */
  data?: Record<string, unknown>;

  /** Guard flag so consumers can branch on denial without parsing strings. */
  blocked?: boolean;
}

/**
 * Narrow runtime check for a ToolResult. We don't hand this out as a hard
 * guarantee — callers still sanitise via {@link normaliseToolResult} — but it
 * lets the wrapper branch efficiently on likely-structured returns.
 */
export function isToolResult(value: unknown): value is ToolResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ToolResult).modelContent === 'string' &&
    typeof (value as ToolResult).userSummary === 'string'
  );
}

/**
 * Options for {@link normaliseToolResult}.
 *
 * `tool` is the name of the tool whose return value is being normalised. The
 * loop always supplies it, so every caller-registered tool's output is
 * content-guarded; direct callers may omit it to get the raw two-view
 * normalisation without a frame (that path never reaches a model by itself).
 */
export interface NormaliseOptions {
  /** Tool name, stamped on the `<tool_output>` frame and used in `data`. */
  tool?: string;
  /** Cap override for the guard; defaults to `DEFAULT_MAX_READ_BYTES` (256 KB). */
  maxBytes?: number;
}

/**
 * Normalise a tool's raw return value into a ToolResult.
 *
 * - `ToolResult` passes through unchanged: the tool has taken responsibility
 *   for its own guards (every built-in tool does).
 * - Anything else is stringified (a plain string as-is, everything else via
 *   `JSON.stringify`), and then — when `opts.tool` is supplied — put through
 *   the same content guards the built-in tools use: framed in
 *   `<tool_output tool="…" source="tool-return">` boundary tags, injection
 *   markers redacted, forged boundary tags escaped, and capped at 256 KB.
 *
 * The guard exists because a caller-registered tool (a web scraper, an HTTP
 * fetch, a third-party API wrapper) returns third-party text: before
 * agent-do-3qb that text reached the model with no boundary and no redaction,
 * unlike every built-in output path. A tool that has *already* sanitised its
 * output can return a `ToolResult` and is passed through untouched — that is
 * the escape hatch, not a config flag.
 *
 * `userSummary` deliberately keeps the tool's own text so operator logs keep
 * the diagnostics (the frame and redaction are for the model's context).
 */
export function normaliseToolResult(
  raw: unknown,
  opts?: NormaliseOptions,
): ToolResult {
  if (isToolResult(raw)) return raw;

  const text = stringifyToolReturn(raw);
  const tool = opts?.tool;
  if (!tool) return { modelContent: text, userSummary: text };

  const wrapped = wrapForModel(text, {
    tool,
    source: TOOL_RETURN_SOURCE,
    ...(opts?.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
  });

  return {
    modelContent: wrapped.content,
    userSummary: text,
    data: {
      guarded: true,
      truncated: wrapped.truncated,
      totalBytes: wrapped.totalBytes,
      redactedMarkerCount: wrapped.redactedMarkerCount,
      neutralisedDelimiterCount: wrapped.neutralisedDelimiterCount,
    },
  };
}

/**
 * Render a non-`ToolResult` return value as text.
 *
 * JSON.stringify returns `undefined` for undefined / functions / symbols, and
 * throws on circular structures. Fall through to String() in either case so
 * the `ToolResult` contract (both fields are strings) is upheld.
 */
function stringifyToolReturn(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  let text: string | undefined;
  try {
    const json = JSON.stringify(raw);
    if (typeof json === 'string') text = json;
  } catch {
    /* fall through to String() */
  }
  return text === undefined ? String(raw) : text;
}
