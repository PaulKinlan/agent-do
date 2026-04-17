/**
 * Conversation-history hygiene for the agent loop. See issue #33.
 *
 * After every outer iteration the loop accumulates more messages: the
 * model's text, its tool calls, and the tool-result messages we feed
 * back. Without intervention the entire history flows verbatim into the
 * next `streamText` call. That has two costs:
 *
 *   1. Token spend — every step pays for every byte of every previous
 *      tool output, even if the model has already reasoned about it.
 *   2. Persistent injection surface — content the agent read in
 *      iteration 2 is still influencing the model in iteration 9, long
 *      after the assistant moved on. A prompt-injected file goes from
 *      "one bad turn" to "every subsequent turn".
 *
 * The compromise this module strikes: keep the most recent N
 * iterations' tool outputs verbatim (the model is actively reasoning
 * about them), and replace older ones with a self-closing
 * `<tool_output ... redacted="stale"/>` marker. The model still sees
 * which tool ran, on what path, but the body is gone.
 *
 * No new model call. No summarisation. Cheap, deterministic, and
 * doesn't make the loop wait on another network round-trip.
 */

import type { ModelMessage } from 'ai';

const OPEN_PREFIX = '<tool_output';
const CLOSE_TAG = '</tool_output>';
// Matches one *opening* tag and captures its attributes (including a
// trailing `/` for self-closing forms). Used only inside the manual
// walker below — not as a global string-replace, because regex
// non-greedy matching stops at the first `</tool_output>`, which is
// wrong when a tool body legitimately contains that literal substring.
const OPEN_TAG_RE = /<tool_output\b([^>]*)>/g;

/**
 * Replace `<tool_output …>…</tool_output>` blocks in a string with
 * self-closing `<tool_output … redacted="stale"/>` markers, preserving
 * the opening tag's attributes so the model retains context about
 * *which* tool produced the redacted body.
 *
 * Why hand-rolled instead of regex? Codex flagged on PR #58 that a
 * non-greedy regex stops at the first `</tool_output>` it sees — so a
 * body that legitimately contains the literal `</tool_output>` string
 * (any file mentioning the marker) only gets partially redacted, and
 * trailing injected content survives. This walker scans for the
 * *last* close tag before either the next opening tag or end of
 * string, which is the right boundary in the realistic case.
 *
 * Behaviours:
 * - Idempotent — already-redacted self-closing markers (`<tool_output
 *   … redacted="stale"/>`) are detected by their `/>` ending and
 *   passed through unchanged.
 * - Fast path — strings with no `<tool_output` substring at all are
 *   returned by reference (important for the structural-sharing
 *   guarantee in {@link redactToolOutputBlocks}).
 * - Malformed input — an opening tag without any matching closer
 *   before the next opening or end is preserved verbatim rather than
 *   silently swallowed.
 *
 * Pathological case worth knowing about: if a tool body contains a
 * `<tool_output …>` *opening* tag literally (rare — would require the
 * agent to be reading its own transcript), the walker treats the
 * inner tag as a new block and partially redacts. That's bounded
 * (worst case: one extra opening tag stays verbatim) and the
 * realistic injection vector is body-with-`</tool_output>`, which is
 * handled correctly.
 */
export function redactToolOutputBlocksInString(s: string): string {
  // Fast path — preserves reference identity for the structural-
  // sharing guarantee that downstream callers rely on.
  if (!s.includes(OPEN_PREFIX)) return s;

  const out: string[] = [];
  let pos = 0;
  let didReplace = false;

  while (pos < s.length) {
    OPEN_TAG_RE.lastIndex = pos;
    const openMatch = OPEN_TAG_RE.exec(s);
    if (!openMatch) {
      out.push(s.slice(pos));
      break;
    }

    const openIdx = openMatch.index;
    const tagEnd = openIdx + openMatch[0].length;
    const rawAttrs = openMatch[1] ?? '';

    // Already redacted (self-closing): pass through.
    if (openMatch[0].endsWith('/>')) {
      out.push(s.slice(pos, tagEnd));
      pos = tagEnd;
      continue;
    }

    // Find the next *opening* tag (so we don't swallow a sibling
    // block) to bound the close search.
    OPEN_TAG_RE.lastIndex = tagEnd;
    const nextOpen = OPEN_TAG_RE.exec(s);
    OPEN_TAG_RE.lastIndex = 0; // reset for the next outer loop iteration
    const searchUpper = nextOpen ? nextOpen.index : s.length;

    // The matching close is the *last* `</tool_output>` strictly
    // before `searchUpper`. lastIndexOf returns -1 if none.
    const closeIdx = s.lastIndexOf(CLOSE_TAG, searchUpper - 1);
    if (closeIdx < tagEnd) {
      // Malformed: opening tag with no closer before the next opening
      // or end. Preserve verbatim so we don't drop trailing text.
      out.push(s.slice(pos, tagEnd));
      pos = tagEnd;
      continue;
    }

    out.push(s.slice(pos, openIdx));
    out.push(`<tool_output${rawAttrs} redacted="stale"/>`);
    pos = closeIdx + CLOSE_TAG.length;
    didReplace = true;
  }

  // Preserve reference identity when nothing was rewritten — keeps
  // the structural-sharing guarantee for the recursive walker.
  return didReplace ? out.join('') : s;
}

/**
 * Recursively walk a value (string, array, object) replacing tool-output
 * blocks anywhere they appear. Used because the AI SDK's tool-result
 * message shape varies by provider — output can be a string, a tagged
 * union (`{type:'text',value:string}`), or a nested object — and we
 * want to redact regardless of the exact shape.
 *
 * **Structural sharing:** when no descendant string was rewritten, the
 * walker returns the *original* value (same reference) rather than a
 * fresh copy. This means {@link stripStaleToolOutputs} only counts a
 * message as "rewritten" when its content actually changed — the
 * `rewritten` count is honest, and we avoid allocating new arrays /
 * objects on every redaction pass for messages that don't contain any
 * `<tool_output>` blocks. (Copilot flagged this on PR #58.)
 */
export function redactToolOutputBlocks(value: unknown): unknown {
  if (typeof value === 'string') return redactToolOutputBlocksInString(value);

  if (Array.isArray(value)) {
    let changed = false;
    const out = new Array<unknown>(value.length);
    for (let i = 0; i < value.length; i++) {
      const next = redactToolOutputBlocks(value[i]);
      if (next !== value[i]) changed = true;
      out[i] = next;
    }
    return changed ? out : value;
  }

  if (value !== null && typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const next = redactToolOutputBlocks(v);
      if (next !== v) changed = true;
      out[k] = next;
    }
    return changed ? out : value;
  }

  return value;
}

/**
 * Mutates `messages` in place: for every tool-role message at an index
 * **less than** `keepFromIndex`, replace tool-output bodies with the
 * stale marker. Other messages (system, user, assistant) are left as
 * they are — assistant text is the model's own reasoning and may
 * legitimately reference earlier tool output.
 *
 * Idempotent: messages that have already been redacted are no-ops.
 *
 * Returns the count of messages that were actually rewritten, for
 * tests and telemetry.
 */
export function stripStaleToolOutputs(
  messages: ModelMessage[],
  keepFromIndex: number,
): number {
  if (keepFromIndex <= 0) return 0;
  let rewritten = 0;
  const ceiling = Math.min(keepFromIndex, messages.length);
  for (let i = 0; i < ceiling; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== 'tool') continue;
    const original = msg.content;
    if (original === undefined) continue;
    const redacted = redactToolOutputBlocks(original);
    if (redacted !== original) {
      // Only count messages where something actually changed (the
      // walker returns the same string when there's nothing to redact,
      // but we care about reference equality on the top-level array
      // because the walker always returns a fresh array/object).
      messages[i] = {
        ...msg,
        content: redacted as ModelMessage['content'],
      } as ModelMessage;
      rewritten++;
    }
  }
  return rewritten;
}

/**
 * Compute the cutoff index for {@link stripStaleToolOutputs}, given a
 * stack of iteration boundaries and a `keepWindow` of recent
 * iterations to keep verbatim.
 *
 *   iterationStarts = [0, 5, 11, 18]
 *   keepWindow = 1  → keep only iter 3 fresh → cutoff = 18
 *   keepWindow = 2  → keep iter 2..3 fresh   → cutoff = 11
 *   keepWindow >= iterations → cutoff = 0 (nothing redacted)
 *
 * `Infinity` (or any value ≥ iterationStarts.length) restores the
 * pre-#33 behaviour where every iteration's history flows in full.
 */
export function cutoffForKeepWindow(
  iterationStarts: readonly number[],
  keepWindow: number,
): number {
  // Coerce to integer up front. A fractional value (e.g. 1.5 from a
  // parsed config) used to fall through to a non-integer property
  // lookup that returned `undefined` and silently disabled redaction.
  // Codex + Copilot both flagged this on PR #58. Treat it predictably
  // as "round down" so the option behaves like the user expects.
  const window = Number.isFinite(keepWindow) ? Math.floor(keepWindow) : keepWindow;

  if (!Number.isFinite(window)) return 0;
  if (window >= iterationStarts.length) return 0;
  if (window <= 0) {
    // Treat 0 / negative as "redact everything older than the current
    // iteration about to run" — same as `keepWindow = 1` semantically,
    // since the in-progress iteration hasn't yet pushed its messages.
    return iterationStarts[iterationStarts.length - 1] ?? 0;
  }
  return iterationStarts[iterationStarts.length - window] ?? 0;
}
