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
 *    terminated by a newline. A bare trailing `---` at EOF is not a fence. A
 *    fence that would close an *empty* block (it sits immediately at the start
 *    of the frontmatter) is skipped when a later fence exists — the regex
 *    could not close there either, because its `\n---` needs a newline the
 *    opening `\s*\n` had not already consumed. This matters in practice: in
 *    `---\n\n---\nname: x\n---\nbody` that second fence is YAML's own document
 *    marker, so the metadata after it must still be parsed instead of being
 *    pushed into the body behind an empty block.
 *  - `frontmatter` is the text strictly between the fence lines; `body` is
 *    everything after the closing fence line, with blank/whitespace-only
 *    lines immediately after it skipped (again, the old `\s*\n`).
 *  - an opening fence with no closing fence → `null` (no frontmatter).
 *
 * Two differences remain, and they are the same case seen twice — a document
 * whose first fence pair is adjacent, or separated by blank lines only:
 *  - `---\n---\nrest` and `---\n\n---\nrest` return an empty frontmatter and
 *    `rest` as the body; the regex found no closing fence at all and callers
 *    saw the whole document as the body. policies and shellm already behaved
 *    the scanner's way; skills and routines are now uniform with them.
 *  - a frontmatter block that is *entirely* whitespace (`---\n \n---\nbody`)
 *    comes back as `''` rather than as that whitespace run.
 *
 * Two differences remain, and they differ in visibility:
 *  - **Observable, and a deliberate body change**: for a document whose only
 *    fences are adjacent or separated by blank lines (`---\n---\nrest`,
 *    `---\n\n---\nrest`) the scan reports an empty frontmatter and `rest` as the
 *    body, where the old skills/routines regex matched nothing and callers kept
 *    the whole document — fence lines included — as the body. That affects a
 *    document which is nothing but an empty metadata block plus content: the
 *    block was metadata-free either way, so no metadata is lost, but the body
 *    no longer carries those fence lines. policies and shellm already behaved
 *    the scanner's way, and skills and routines are now uniform with them.
 *  - **Not observable**: a frontmatter block that is *entirely* whitespace
 *    (`---\n \n---\nbody`) comes back as `''` rather than as that whitespace
 *    run, and every caller YAML-parses the frontmatter, where `YAML.parse(' ')`
 *    and `YAML.parse('')` are both "no metadata".
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

  // A fence sitting immediately at the start of the frontmatter would close an
  // empty block. Prefer a later fence when there is one (see the header
  // comment); keep the empty block as the fallback for a document that has no
  // other fence to close on.
  let emptyCandidate: FrontmatterSplit | null = null;

  // Closing fence: the next `---`-only line. Linear scan, no backtracking.
  let lineStart = afterOpen;
  while (lineStart <= content.length) {
    const nextNl = content.indexOf('\n', lineStart);
    const lineEnd = nextNl === -1 ? content.length : nextNl;
    if (fenceLineEnd(content, lineStart) === lineEnd) {
      // `---` line at [lineStart, lineEnd). It's a valid closing fence only
      // if followed by a line ending (the old `\n---\s*\n` requirement).
      if (lineEnd >= content.length) break; // bare trailing `---` → keep scanning → no match
      const split: FrontmatterSplit = {
        frontmatter: content.slice(afterOpen, Math.max(afterOpen, lineStart - 1)),
        body: content.slice(skipBlankLines(content, lineEnd + 1)),
      };
      if (lineStart !== afterOpen) return split;
      if (!emptyCandidate) emptyCandidate = split;
    }
    if (nextNl === -1) break;
    lineStart = nextNl + 1;
  }
  return emptyCandidate;
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
