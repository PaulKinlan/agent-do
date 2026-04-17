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
 * Normalise a tool's raw return value into a ToolResult.
 *
 * - `ToolResult` passes through unchanged.
 * - A plain string becomes `{ modelContent: s, userSummary: s }`.
 * - Anything else is JSON-stringified for both views.
 *
 * This keeps every existing tool (library consumers, user-authored tools)
 * working without changes. Tools that want the rich behaviour opt in by
 * returning a `ToolResult` explicitly.
 */
export function normaliseToolResult(raw: unknown): ToolResult {
  if (isToolResult(raw)) return raw;
  if (typeof raw === 'string') return { modelContent: raw, userSummary: raw };
  const text = (() => {
    try {
      return JSON.stringify(raw);
    } catch {
      return String(raw);
    }
  })();
  return { modelContent: text, userSummary: text };
}
