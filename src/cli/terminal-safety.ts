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
