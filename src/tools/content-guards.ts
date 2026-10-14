/**
 * Content guards used by file / memory tools before data flows back to the
 * model. See issue #48 — these sit between the raw store output and the
 * model-facing `modelContent` field of a `ToolResult`.
 *
 * The helpers here are deliberately conservative. The idea is not to defeat
 * every possible injection (that's impossible) but to raise the cost and
 * cap the blast radius:
 *
 *   - size caps stop a 2 GB log file from blowing the model context / cost;
 *   - boundary markers give the model a structural hint that content inside
 *     a tool output block is data, not instructions;
 *   - marker redaction replaces the most obvious "ignore previous
 *     instructions" style prompts with a visible marker so reviewers can
 *     spot attempted injections post-hoc.
 */

/**
 * Default hard cap on the bytes we hand to the model from a single read.
 * Chosen small enough that a model with a 128k-token context still sees
 * plenty of room for conversation and output.
 */
export const DEFAULT_MAX_READ_BYTES = 256 * 1024;

/** Default hard cap on the content a tool can write in one call. */
export const DEFAULT_MAX_WRITE_BYTES = 1 * 1024 * 1024;

/** Per-match-line cap for grep-style tools. */
export const DEFAULT_MAX_GREP_LINE_BYTES = 4 * 1024;

/**
 * Conservative pattern matching the most common prompt-injection openers.
 *
 *   - "ignore previous/prior/above instructions"
 *   - "disregard all prior instructions"
 *   - `<system>` / `</system>` / `<<system>>` tags
 *   - the `<tool_output>` boundary itself, so content cannot close the
 *     frame early and have the rest read as instructions from outside it
 *   - markdown rulers like `--- system` / `--- instruction` / `--- override`
 *
 * We match case-insensitively and multi-line. Hits are *replaced* with a
 * visible `[redacted prompt-injection marker]` so the model still sees the
 * surrounding text and the operator can audit what was stripped via the
 * `redactedMarkerCount` field on the `ToolResult`.
 */
export const INJECTION_MARKER_REGEX =
  /(?:ignore|disregard)(?:\s+(?:all|the|any|these|those))?\s+(?:prior|previous|above|preceding)\s+instructions|<\/?system>|<<\s*system\s*>>|^---\s*(?:system|instruction|override)|<\/?tool_output\b[^>]*>/gim;

export type WrapOptions = WrapOrigin & {
  /** Tool that produced the content (read_file, memory_read, bash, etc.). */
  tool: string;
  /** Optional cap override, defaults to {@link DEFAULT_MAX_READ_BYTES}. */
  maxBytes?: number;
};

/**
 * Where the wrapped content came from — echoed in the boundary marker
 * attributes. A file/memory read gives a `path`; a command runner (the
 * shell tool) gives a `command`. At least one is required, so a marker
 * always names its origin.
 */
export type WrapOrigin =
  | { path: string; command?: string }
  | { path?: string; command: string };

// Portable UTF-8 helpers. agent-do runs in browsers as well as Node, so we
// use the WHATWG TextEncoder / TextDecoder rather than `Buffer`. Both are
// available in Node 11+, all modern browsers, Deno, Bun, and Cloudflare
// Workers.

const utf8Encoder = /*#__PURE__*/ new TextEncoder();
const utf8Decoder = /*#__PURE__*/ new TextDecoder('utf-8', { fatal: false });

/**
 * Wrapper delimiters that must never appear verbatim inside a wrapped body.
 *
 * A file or a command can emit a literal `</tool_output>`, which would close
 * the block early and leave everything after it as top-level text — exactly
 * the injection the marker exists to prevent. Open and close forms are both
 * matched.
 */
export const BOUNDARY_TAG_REGEX = /<\/?tool_output\b[^>]*>/gi;

/**
 * HTML-escape boundary tags in `body` so they stay visible to the model (and
 * to an operator reading the transcript) without acting as delimiters.
 * Returns the count so callers can report what was altered.
 */
function neutraliseBoundaryTags(body: string): { body: string; count: number } {
  let count = 0;
  const neutralised = body.replace(BOUNDARY_TAG_REGEX, (tag) => {
    count++;
    return tag.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  });
  return { body: neutralised, count };
}

/** Length of a string in UTF-8 bytes. */
export function utf8ByteLength(s: string): number {
  return utf8Encoder.encode(s).length;
}

/**
 * Truncate `s` to at most `maxBytes` UTF-8 bytes without splitting a
 * codepoint mid-sequence. Returns the original string when it already
 * fits. The decoder is non-fatal, so any partial trailing sequence is
 * dropped silently rather than throwing.
 */
export function truncateUtf8ByBytes(s: string, maxBytes: number): string {
  const bytes = utf8Encoder.encode(s);
  if (bytes.length <= maxBytes) return s;
  return utf8Decoder.decode(bytes.subarray(0, maxBytes));
}

export interface WrappedContent {
  /** The final string to hand to the model. */
  content: string;
  /** Was the raw content clipped to fit under `maxBytes`? */
  truncated: boolean;
  /** Bytes of content we actually included (pre-markers, pre-redaction). */
  includedBytes: number;
  /** Total bytes we were given (for user summary / size-visibility). */
  totalBytes: number;
  /** Count of injection markers we redacted in the included slice. */
  redactedMarkerCount: number;
  /**
   * Count of `<tool_output>` boundary tags found in the body and escaped so
   * content cannot close its own frame. Separate from
   * {@link WrappedContent.redactedMarkerCount}, which counts injection
   * phrases.
   */
  neutralisedDelimiterCount: number;
}

/**
 * Produce the model-facing string for a file / memory / tool read.
 *
 * Wraps the content in `<tool_output tool="…" path="…">…</tool_output>`
 * (or `command="…"` for command output), applies the size cap, replaces
 * obvious injection markers, and escapes any `<tool_output>` tag in the body
 * so content cannot close the frame it was placed in. Returns enough metadata
 * for the caller to populate `ToolResult.data`.
 */
/**
 * Make a value safe to place inside one line of a rendered, line-oriented listing.
 *
 * A filename may contain a newline, and a listing IS lines: without this, the second half of a name renders
 * as a line of its own, which the deny-list filter then reads as a separate entry. The continuation can even
 * be a syntactically valid entry ("[file] x"), so a name could mint an entry that does not exist
 * (agent-do-0fr - the same class as agent-do-2rm: a line-oriented format with an unescaped separator).
 *
 * Backslash is escaped FIRST so the result is unambiguous and reversible: a real backslash renders as "\\"
 * and a real newline as "\n" (two characters), so no name can be read as a different name.
 */
export function escapeForLine(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

export function wrapForModel(body: string, opts: WrapOptions): WrappedContent {
  const cap = opts.maxBytes ?? DEFAULT_MAX_READ_BYTES;
  const totalBytes = utf8ByteLength(body);
  const truncated = totalBytes > cap;
  const clipped = truncated ? truncateUtf8ByBytes(body, cap) : body;

  const { body: neutralised, count: neutralisedDelimiterCount } =
    neutraliseBoundaryTags(clipped);

  let redactedMarkerCount = 0;
  const redacted = neutralised.replace(INJECTION_MARKER_REGEX, () => {
    redactedMarkerCount++;
    return '[redacted prompt-injection marker]';
  });

  const trailer = truncated
    ? `\n... [truncated at ${cap} bytes of ${totalBytes}]`
    : '';

  const attrs = [`tool="${escapeAttr(opts.tool)}"`];
  if (opts.path !== undefined) {
    attrs.push(`path="${escapeAttr(opts.path)}"`);
  }
  if (opts.command !== undefined) {
    attrs.push(`command="${escapeAttr(opts.command)}"`);
  }

  const content = [
    `<tool_output ${attrs.join(' ')}>`,
    redacted + trailer,
    `</tool_output>`,
  ].join('\n');

  return {
    content,
    truncated,
    includedBytes: utf8ByteLength(clipped),
    totalBytes,
    redactedMarkerCount,
    neutralisedDelimiterCount,
  };
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Sanitise a filesystem error into user-safe + model-safe views.
 *
 * The model-facing string is constructed from an allowlisted errno code
 * table — never the raw `err.message`, which typically leaks absolute
 * paths, host info, and OS version details. The user-facing string keeps
 * the rich diagnostic.
 *
 * Our own guard errors (path traversal, read-only) are detected by exact
 * message prefix — not by heuristics — so they flow through to the model
 * unchanged. This avoids the brittle `/` test from the superseded PR #45
 * and works identically on POSIX and Windows.
 */
export const SAFE_GUARD_ERROR_PREFIXES: readonly string[] = [
  'Path traversal not allowed',
  'Path traversal via symlink not allowed',
  'Write blocked',
  'Blocked by deny list',
  // Stores throw `File not found: <relative path>` when an existence check
  // pre-empts the underlying ENOENT. Allow the message through — the path
  // is always the relative argument we were given, not an absolute host
  // path, and the specific "not found" phrasing is useful to the model.
  'File not found',
];

export interface SanitisedError {
  /** Short, path-local, host-info-free string safe to hand to the model. */
  modelContent: string;
  /** Rich diagnostic (may include absolute paths, errno) for operator logs. */
  userSummary: string;
  /** Error code if recognised. */
  code?: string;
  /** Raw error message — only put this in `data` for programmatic use. */
  rawMessage: string;
}

export function sanitiseFsError(
  err: unknown,
  op: string,
  relPath: string,
): SanitisedError {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const code = err instanceof Error
    ? (err as NodeJS.ErrnoException).code
    : undefined;

  // Allowlisted guard errors — flow through verbatim. They don't contain
  // paths or host info; the model benefits from the specific reason.
  if (
    !code &&
    SAFE_GUARD_ERROR_PREFIXES.some((prefix) => rawMessage.startsWith(prefix))
  ) {
    return {
      modelContent: rawMessage,
      userSummary: `[${op}] ${relPath} — ${rawMessage}`,
      rawMessage,
    };
  }

  const modelContent = (() => {
    switch (code) {
      case 'ENOENT':
        return `File not found: ${relPath}`;
      case 'EACCES':
      case 'EPERM':
        return `Permission denied: ${relPath}`;
      case 'EISDIR':
        return `Expected a file, got a directory: ${relPath}`;
      case 'ENOTDIR':
        return `Expected a directory, got a file: ${relPath}`;
      case 'EEXIST':
        return `File already exists: ${relPath}`;
      case 'EMFILE':
      case 'ENFILE':
        return `Too many open files — retry later`;
      case 'EROFS':
        return `Filesystem is read-only: ${relPath}`;
      default:
        return `Error during ${op} on ${relPath}`;
    }
  })();

  const userSummary = `[${op}] ${relPath} — ${code ? code + ': ' : ''}${rawMessage}`;

  return { modelContent, userSummary, code, rawMessage };
}
