/**
 * Frontmatter splitting for the markdown-backed stores (skills, routines,
 * policies) and the `.shellm` prompt loader.
 *
 * Replaces the `^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$` shape that CodeQL
 * flags as `js/polynomial-redos` (a `\s*` that can also match newlines sitting
 * next to a lazy `[\s\S]*?`). The scan below walks lines with `indexOf`, so a
 * hostile document — `---\n` followed by a long run of whitespace-only lines
 * with no closing fence, the case that makes the regex backtrack — parses in
 * O(n) with no regex engine to abuse.
 *
 * Semantics. Whitespace handling mirrors the regex being replaced, so callers
 * see the same split they did before:
 *  - **opening fence**: a first line whose content is exactly `---` (optional
 *    trailing horizontal whitespace) terminated by a newline. Blank or
 *    whitespace-only lines after it are skipped (the old `\s*\n` did that
 *    too); other leading whitespace on the first content line is preserved.
 *  - **closing fence**: a later line whose content is exactly `---`, also
 *    terminated by a newline. A bare trailing `---` at EOF is not a fence.
 *  - `frontmatter` is the text strictly between the fence lines; `body` is
 *    everything after the closing fence line, with blank/whitespace-only
 *    lines immediately after it skipped (again, the old `\s*\n`).
 *  - an opening fence with no closing fence → `null` (no frontmatter).
 *
 * One deliberate difference: two adjacent fences (`---\n---\nrest`) return an
 * empty `frontmatter` and `rest` as the body. The old skills/routines regex
 * could not match that shape — the opening fence consumes the only newline
 * before `---` — so those callers saw the whole document as the body, while
 * policies and shellm already behaved the new way. Uniform semantics wins:
 * every caller YAML-parses the frontmatter, so the only visible difference is
 * "this document has an empty metadata block".
 *
 * A second, unobservable difference: a frontmatter block that is *entirely*
 * whitespace (`---\n \n---\nbody`) comes back as `''` rather than as that
 * whitespace run, because the scan commits to the maximal skip where the old
 * regex backtracked. Every caller YAML-parses the frontmatter, and
 * `YAML.parse(' ')` and `YAML.parse('')` are both "no metadata".
 */

export interface FrontmatterSplit {
  /** Text between the fences, exclusive of both fence lines. */
  frontmatter: string;
  /** Everything after the closing fence line. */
  body: string;
}

/**
 * Split a markdown document into YAML frontmatter + body. Returns `null` when
 * there is no valid frontmatter fence.
 */
export function splitFrontmatter(content: string): FrontmatterSplit | null {
  // Opening fence: the document itself must start with `---`. Whitespace and
  // blank lines come after the dashes (`---\u00a0\n`, `---\n\nname: x`), never
  // instead of them — without this check any 3-character first line would be
  // treated as a fence.
  if (content[0] !== '-' || content[1] !== '-' || content[2] !== '-') return null;
  // The fence line must be terminated by a newline; blank lines after it are
  // skipped (the old `\s*\n`).
  const afterOpen = afterFenceWhitespace(content, 3);
  if (afterOpen === -1) return null;

  // Closing fence: the next `---`-only line. Linear scan, no backtracking.
  let lineStart = afterOpen;
  while (lineStart <= content.length) {
    const nextNl = content.indexOf('\n', lineStart);
    const lineEnd = nextNl === -1 ? content.length : nextNl;
    if (fenceLineEnd(content, lineStart) === lineEnd) {
      // `---` line at [lineStart, lineEnd). It's a valid closing fence only
      // if followed by a line ending (the old `\n---\s*\n` requirement).
      if (lineEnd >= content.length) break; // bare trailing `---` → keep scanning → no match
      const frontEnd = Math.max(afterOpen, lineStart - 1);
      return {
        frontmatter: content.slice(afterOpen, frontEnd),
        body: content.slice(skipBlankLines(content, lineEnd + 1)),
      };
    }
    if (nextNl === -1) break;
    lineStart = nextNl + 1;
  }
  return null;
}

/**
 * Starting at `from` (just past a `---` fence), skip the run of whitespace
 * that follows and return the index the following text starts at — i.e. just
 * after the last newline in that run. Returns -1 when the run contains no
 * newline, so a bare `---foo` is not a fence.
 *
 * This reproduces the old regex's greedy `\s*\n`: whitespace-only lines are
 * consumed, while indentation on the first content line is kept. Returns -1
 * when no newline follows the fence, so a bare `---foo` is not a fence.
 */
function afterFenceWhitespace(content: string, from: number): number {
  const i = skipBlankLines(content, from);
  return i > from && content[i - 1] === '\n' ? i : -1;
}

/**
 * Skip the run of whitespace at `from` and return where the following text
 * starts: just past the last newline in that run. Indentation on the first
 * non-blank line is kept. Used for the body, where the closing fence line's
 * own newline has already been consumed.
 */
function skipBlankLines(content: string, from: number): number {
  let i = from;
  while (i < content.length && isWhitespace(content[i])) i++;
  while (i > from && content[i - 1] !== '\n') i--;
  return i;
}

/**
 * If the line starting at `start` is exactly `---` optionally followed by
 * trailing whitespace, return the index just past the line's content (the
 * position of the terminating `\n` or EOF). Otherwise return -1.
 *
 * The trailing set is any whitespace except a newline, because that is what
 * the old `\n---\s*\n` accepted (`\s*` could hold tabs, `\r`, NBSP, `\ufeff`,
 * … — the required `\n` is what closed the fence).
 */
function fenceLineEnd(s: string, start: number): number {
  if (s[start] !== '-' || s[start + 1] !== '-' || s[start + 2] !== '-') return -1;
  let i = start + 3;
  while (i < s.length && s[i] !== '\n' && isWhitespace(s[i])) i++;
  return i;
}

function isWhitespace(ch: string | undefined): boolean {
  return ch !== undefined && ch.trim() === '';
}
