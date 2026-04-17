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

const TOOL_OUTPUT_BLOCK = /<tool_output\b([^>]*)>[\s\S]*?<\/tool_output>/g;

/**
 * Replace `<tool_output …>…</tool_output>` blocks in a string with
 * self-closing markers, preserving the opening tag's attributes so the
 * model retains context about *which* tool produced the redacted body.
 *
 * The replacement is idempotent — markers we've already redacted (which
 * are self-closing and contain no `</tool_output>` closer) are left
 * alone by the regex.
 */
export function redactToolOutputBlocksInString(s: string): string {
  return s.replace(TOOL_OUTPUT_BLOCK, '<tool_output$1 redacted="stale"/>');
}

/**
 * Recursively walk a value (string, array, object) replacing tool-output
 * blocks anywhere they appear. Used because the AI SDK's tool-result
 * message shape varies by provider — output can be a string, a tagged
 * union (`{type:'text',value:string}`), or a nested object — and we
 * want to redact regardless of the exact shape.
 *
 * Returns a new value tree; the input is untouched.
 */
export function redactToolOutputBlocks(value: unknown): unknown {
  if (typeof value === 'string') return redactToolOutputBlocksInString(value);
  if (Array.isArray(value)) return value.map(redactToolOutputBlocks);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactToolOutputBlocks(v);
    }
    return out;
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
  if (!Number.isFinite(keepWindow)) return 0;
  if (keepWindow >= iterationStarts.length) return 0;
  if (keepWindow <= 0) {
    // Treat 0 / negative as "redact everything older than the current
    // iteration about to run" — same as `keepWindow = 1` semantically,
    // since the in-progress iteration hasn't yet pushed its messages.
    return iterationStarts[iterationStarts.length - 1] ?? 0;
  }
  return iterationStarts[iterationStarts.length - keepWindow] ?? 0;
}
