/**
 * Terminal safety for operator-facing output (agent-do-9zk).
 *
 * The CLI prints tool-derived text to stderr: tool result summaries, `data` previews, `--show-content`
 * bodies, tool arguments, model thinking and (at debug/trace) message bodies. All of that is content the
 * agent did not author — a file in a hostile repository, a web page, an MCP server, a delegated worker —
 * and a terminal does not render control characters as text, it OBEYS them.
 *
 * What a raw byte can do to the operator, none of it visible in the text:
 * - `ESC ] 52 ; c ; <base64> BEL` (OSC 52) puts attacker-chosen text in the operator's CLIPBOARD.
 * - `ESC ] 0 ; <title> BEL` rewrites the window/tab title, which outlives the process.
 * - `ESC [ ... m` / `ESC [ 2 J` / cursor moves recolour, erase or overwrite lines that were already
 *   printed — so the audit trail the operator just read can be rewritten underneath them.
 * - `ESC [ 8 m` and OSC 8 make a URL appear as a different URL when hovered/clicked.
 * - U+202A-U+202E and U+2066-U+2069 (bidi overrides/isolates) reverse a rendered path or command, so
 *   `src/evil.ts` can be displayed as `src/ts.live` (the Trojan Source class).
 *
 * THE FIX IS TO BREAK THE INTRODUCER, not to parse sequences. Every one of those needs an introducer byte
 * — ESC (U+001B) or, in 8-bit form, the C1 controls U+009B/U+009D — and once the introducer is gone the
 * remaining payload is inert printable text. So C0/C1 controls (except newline and tab, which the renderer
 * legitimately uses) and the bidi controls are replaced with a visible `[U+XXXX]` marker. Visible, not
 * dropped: the operator should see that something tried, and a silently stripped payload is a signal lost.
 *
 * This is deliberately NOT applied to the model-facing path. `wrapForModel` in `src/tools/content-guards.ts`
 * guards a different consumer with different rules (injection markers, `<tool_output>` boundaries); this
 * module guards a human's terminal. Keeping them separate is why neither has to compromise.
 */

/** C0 and C1 controls, minus newline (U+000A) and tab (U+0009), which the renderer uses for layout. */
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
/** Bidirectional overrides, embeddings and isolates, plus the two marks that force direction. */
const BIDI = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Is this single character unsafe on a terminal?
 *
 * Exported so the two renderings share ONE definition: `sanitiseForTerminal` replaces such a character with a
 * visible `[U+XXXX]` marker, while `printable` (used by the saved-agent listings, agent-do-2ey) replaces it with
 * `?` because a table wants a fixed width. Two separate character classes would drift, and the earlier `printable`
 * missed the bidi controls entirely.
 */
export function isTerminalUnsafe(ch: string): boolean {
  return isUnsafeSet(ch);
}

/**
 * Is this character unsafe inside a SINGLE-LINE field (a table cell, one diagnostic line)?
 *
 * Strictly more than {@link isTerminalUnsafe}: newline, carriage return and tab are layout in a multi-line answer,
 * but inside one line they let planted content forge a second line - which is exactly what the saved-agent
 * diagnostics defend against (agent-do-2ey). Sharing only the unsafe *set* and forgetting this distinction broke
 * those tests for real when this module was introduced: `printable` had been replacing every C0 character, and
 * delegating it to the multi-line predicate quietly stopped it replacing newlines (agent-do-bc4).
 */
export function isSingleLineUnsafe(ch: string): boolean {
  return ch === '\n' || ch === '\r' || ch === '\t' || isUnsafeSet(ch);
}

/**
 * Replace every single-line-unsafe character with `?` (agent-do-bc4, agent-do-wcq follow-up).
 *
 * This is the rendering for a FIELD: a table cell, one diagnostic line, one row. Unlike
 * {@link sanitiseForTerminal} it does not preserve newline or tab - inside one field those characters are not
 * layout, they are a way for a value to forge another row or another column.
 */
export function sanitiseForLine(text: string): string {
  let out = '';
  for (const ch of text) out += isSingleLineUnsafe(ch) ? '?' : ch;
  return out;
}

/**
 * Build one table row from untrusted cells: the STRUCTURE is ours, the CELLS are not.
 *
 * `separator` and the optional `suffix` are our formatting (a tab between columns, a ` — description` tail), so
 * they are emitted as-is; every cell and the suffix's interpolated value go through {@link sanitiseForLine}, so no
 * value can start a new row or add a column. Escaping the whole assembled row instead was the bug: the row
 * sanitiser preserves newlines, which left a description able to forge a line in `scheduled-tasks list`.
 */
export function sanitiseRow(
  cells: readonly (string | number)[],
  separator = '\t',
  suffix = '',
): string {
  return cells.map((cell) => sanitiseForLine(String(cell))).join(separator) + sanitiseForLine(suffix);
}

function isUnsafeSet(ch: string): boolean {
  // Both patterns are global, and a global regex remembers `lastIndex` between `test` calls - so reset it, or
  // every second character would be misclassified.
  CONTROLS.lastIndex = 0;
  BIDI.lastIndex = 0;
  return CONTROLS.test(ch) || BIDI.test(ch);
}

function visible(match: string): string {
  const code = match.codePointAt(0) ?? 0;
  return `[U+${code.toString(16).toUpperCase().padStart(4, '0')}]`;
}

/**
 * Replace terminal control sequences and bidi controls with visible markers.
 *
 * Preserves newline and tab. Idempotent: the replacement text contains no control characters, so a second
 * pass changes nothing.
 */
export function sanitiseForTerminal(text: string): string {
  return text.replace(CONTROLS, visible).replace(BIDI, visible);
}
