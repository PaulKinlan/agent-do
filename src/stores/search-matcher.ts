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
 *   safe to call concurrently without `lastIndex` resets.
 *
 * ## Safety
 *
 * Regex patterns get two filters before compilation:
 *
 * 1. A hard length cap (256 chars).
 * 2. A structural scan that rejects any quantifier applied to a group
 *    which *itself* contains an alternation or another quantifier.
 *    This is the shape that causes catastrophic backtracking and
 *    covers `(a+)+`, `(a|a?)+`, `(a+){1,}`, `((a|a?))+`, `(a+|b){2,}`,
 *    and other variants the earlier regex-on-regex heuristic missed
 *    (Codex #63 follow-ups on wrapping and brace quantifiers).
 *
 * The scan is character-by-character and respects character classes,
 * escapes, and nested parens. It's ~30 lines — cheap to run once per
 * call, and its failure mode is conservative (rejects more than
 * strictly necessary), which is the right trade-off for a defence
 * against untrusted patterns.
 */

export const MAX_REGEX_PATTERN_LENGTH = 256;

/**
 * True iff `pattern` contains a quantifier applied to a group whose
 * body contains an alternation or another quantifier. This is the
 * structural shape behind most catastrophic-backtracking regexes.
 *
 * Conservative by design: we reject `(a+)+`, `(a|b)+`, and any wrapper
 * combination of those. We do *not* try to decide whether the
 * alternation branches actually overlap (which would require a
 * solver); false positives are cheap (user rewrites), false negatives
 * hang the loop.
 */
function hasDangerousNesting(pattern: string): boolean {
  // `groupStack` tracks, for each currently-open paren, whether the
  // body seen so far contains an alternation or a quantifier. Closing
  // a group consults the top-of-stack flag; if the group is then
  // followed by a quantifier, that's the danger shape.
  const groupStack: { risky: boolean }[] = [];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      // Skip escaped char (regardless of what it is — can't influence structure).
      i += 2;
      continue;
    }
    if (ch === '[') {
      // Character class — scan to the unescaped `]`. Contents don't
      // participate in group nesting or quantifier propagation.
      i++;
      while (i < pattern.length && pattern[i] !== ']') {
        if (pattern[i] === '\\') i += 2;
        else i++;
      }
      i++;
      continue;
    }
    if (ch === '(') {
      groupStack.push({ risky: false });
      i++;
      // Skip group-prefix tokens so they aren't misread as quantifiers
      // later (Codex #63 follow-up: `(?:…)`, `(?=…)`, `(?!…)`,
      // `(?<=…)`, `(?<!…)`, `(?<name>…)`). The `?` right after `(` is
      // part of the introducer, not a `0-or-1` quantifier on an
      // imaginary preceding atom. Without this `(?:ab)+` reads as a
      // group whose body contains a `?` quantifier, and every
      // non-capturing / lookaround / named group with a trailing
      // quantifier trips the guard.
      if (pattern[i] === '?') {
        i++;
        // Lookbehind (`(?<=` or `(?<!`) and named capture (`(?<name>`)
        // both start with `<`. For named captures we also skip past
        // the `>` so the name isn't scanned as regex structure.
        if (pattern[i] === '<') {
          i++;
          if (pattern[i] !== '=' && pattern[i] !== '!') {
            while (i < pattern.length && pattern[i] !== '>') i++;
            if (pattern[i] === '>') i++;
          }
        } else if (pattern[i] === '=' || pattern[i] === '!' || pattern[i] === ':') {
          // Lookahead / non-capturing — single-char prefix, already
          // past the `?`; just consume the next char.
          i++;
        }
      }
      continue;
    }
    if (ch === ')') {
      const closed = groupStack.pop();
      if (!closed) { i++; continue; } // stray `)` — let the regex compiler complain
      // What follows the `)` — a quantifier means this group is repeated.
      const nextCh = pattern[i + 1];
      const isQuant =
        nextCh === '+' || nextCh === '*' || nextCh === '?' || nextCh === '{';
      if (isQuant && closed.risky) return true;
      // Even if this group isn't quantified, the outer group (if any)
      // inherits any quantifier/alternation we saw inside — `((a+))+`
      // has a quantifier via the outer group.
      if (closed.risky && groupStack.length > 0) {
        groupStack[groupStack.length - 1]!.risky = true;
      }
      i++;
      continue;
    }
    if (ch === '|') {
      // Alternation inside the current innermost group makes it risky
      // iff followed by a quantifier on `close)`. We mark it now and
      // evaluate at the close.
      if (groupStack.length > 0) groupStack[groupStack.length - 1]!.risky = true;
      i++;
      continue;
    }
    if (ch === '+' || ch === '*' || ch === '?' || ch === '{') {
      // Quantifier applied to something. If we're inside a group, the
      // group body now contains a quantifier, which makes it risky if
      // the whole group is later quantified.
      if (groupStack.length > 0) groupStack[groupStack.length - 1]!.risky = true;
      // Skip the full `{n,m}` range so we don't revisit its digits.
      if (ch === '{') {
        while (i < pattern.length && pattern[i] !== '}') i++;
      }
      i++;
      continue;
    }
    i++;
  }
  return false;
}

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
  if (hasDangerousNesting(pattern)) {
    throw new Error(
      'Regex pattern rejected: contains a quantifier applied to a group ' +
      'that itself contains an alternation or another quantifier (e.g. ' +
      '"(a+)+", "(a|a?)+", "(a+){1,}"). These shapes cause catastrophic ' +
      'backtracking on adversarial input. Rewrite without the nested ' +
      'repetition, or omit `regex: true` to do a literal substring match.',
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
