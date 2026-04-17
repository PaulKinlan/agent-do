/**
 * Shared line-matcher factory for store `search()` implementations.
 *
 * Pulled out of `FilesystemMemoryStore` and `InMemoryMemoryStore` per
 * PR #63 review — the same length cap, the same catastrophic-backtracking
 * guard, and the same regex-compilation path were duplicated in both
 * stores and were at risk of drifting out of sync with each future
 * tweak.
 *
 * ## Modes
 *
 * - **Literal (default):** case-insensitive substring match. Zero
 *   regex surface, zero backtracking risk.
 * - **Regex (`asRegex: true`):** case-insensitive regex, *without* the
 *   `g` flag. A non-global RegExp is stateless, so `.test(line)` is
 *   safe to call concurrently without `lastIndex` resets — Copilot's
 *   review flagged the old `'gi'` flag + per-call reset as a footgun
 *   that's easy to get wrong in future edits.
 *
 * ## Safety
 *
 * Regex patterns get two filters before compilation:
 *
 * 1. A hard length cap (256 chars). Pathological inputs often grow
 *    with pattern length; bounding the pattern bounds the worst case
 *    the engine can be asked to explore.
 * 2. A nested-quantifier heuristic. Two variants are checked because a
 *    single regex can't cover every shape:
 *    - `NESTED_QUANTIFIER_RE` — groups containing `+` or `*` followed
 *      by another quantifier (e.g. `(a+)+`, `(ab*)*`).
 *    - `ALTERNATION_OVERLAP_RE` — groups with `|` alternation and a
 *      trailing quantifier, which catches shapes like `(a|a?)+` and
 *      `(a|aa)*` that exhibit exponential backtracking on `a…a!`
 *      inputs. Codex flagged this form explicitly in PR #63 review.
 *
 * Rejected patterns throw a descriptive `Error`; the tool wrapper
 * surfaces the message to the model so the agent can rewrite instead
 * of silently getting no results.
 */

export const MAX_REGEX_PATTERN_LENGTH = 256;

/** `(a+)+`, `(ab*)*` — group containing `+`/`*` followed by another quantifier. */
const NESTED_QUANTIFIER_RE = /\([^)]*[+*][^)]*\)[+*?]/;

/**
 * `(a|a?)+`, `(a|aa)*`, `(x|x+)+` — alternation inside a group that's
 * followed by a `+`/`*`/`?`/`{n,}`/`{n,m}` quantifier. Any overlap in the
 * alternatives (common when the programmer *intended* to accept
 * repeated matches) produces exponential backtracking on adversarial
 * inputs. We reject the whole shape rather than trying to detect
 * overlap — false positives are cheap (the caller rewrites), false
 * negatives hang the search.
 */
const ALTERNATION_OVERLAP_RE =
  /\([^)]*\|[^)]*\)(?:[+*?]|\{\d+,\d*\})/;

export interface SearchMatcherOptions {
  /** Opt-in regex mode. Default is literal substring. */
  asRegex: boolean;
}

/**
 * Build a per-line matcher closure. The returned function is cheap to
 * call repeatedly across thousands of lines; compilation happens once
 * up front so a failed regex compile is also raised once.
 */
export function buildLineMatcher(
  pattern: string,
  opts: SearchMatcherOptions,
): (line: string) => boolean {
  if (!opts.asRegex) {
    const needle = pattern.toLowerCase();
    return (line) => line.toLowerCase().includes(needle);
  }

  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    throw new Error(
      `Regex pattern too long (${pattern.length} > ${MAX_REGEX_PATTERN_LENGTH} chars).`,
    );
  }
  if (NESTED_QUANTIFIER_RE.test(pattern) || ALTERNATION_OVERLAP_RE.test(pattern)) {
    throw new Error(
      'Regex pattern rejected: contains a nested quantifier (e.g. "(a+)+") ' +
      'or an alternation-with-trailing-quantifier shape (e.g. "(a|a?)+") ' +
      'that can cause catastrophic backtracking. Rewrite without the ' +
      'offending construct, or omit `regex: true` to do a literal match.',
    );
  }

  let re: RegExp;
  try {
    // Non-global: .test() is stateless, so the same compiled RegExp
    // can be reused across lines without lastIndex bookkeeping.
    re = new RegExp(pattern, 'i');
  } catch (err) {
    throw new Error(
      `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return (line) => re.test(line);
}
