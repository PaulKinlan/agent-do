import { describe, it, expect } from 'vitest';
import { splitFrontmatter } from '../src/frontmatter.js';

/**
 * The shape this module replaced. Kept here as a reference implementation so
 * the equivalence test below can prove the line scan returns the same split
 * for well-formed documents. It is only ever run on the small, bounded corpus
 * in that test — never on the hostile input — so it cannot hang the suite.
 */
const PREVIOUS_REGEX = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

describe('splitFrontmatter', () => {
  it('splits frontmatter from body', () => {
    expect(splitFrontmatter('---\nname: x\n---\nbody')).toEqual({
      frontmatter: 'name: x',
      body: 'body',
    });
  });

  it('returns null when the document has no frontmatter', () => {
    expect(splitFrontmatter('# Just a body')).toBeNull();
    expect(splitFrontmatter('')).toBeNull();
  });

  it('requires the opening fence to be the first line', () => {
    expect(splitFrontmatter('\n---\nname: x\n---\nbody')).toBeNull();
    expect(splitFrontmatter('  ---\nname: x\n---\nbody')).toBeNull();
  });

  it('accepts trailing whitespace on either fence', () => {
    expect(splitFrontmatter('---  \nname: x\n---\t\nbody')).toEqual({
      frontmatter: 'name: x',
      body: 'body',
    });
  });

  it('handles CRLF fences', () => {
    expect(splitFrontmatter('---\r\nname: x\r\n---\r\nbody')).toEqual({
      frontmatter: 'name: x\r',
      body: 'body',
    });
  });

  it('closes at the first fence and ignores later --- lines', () => {
    expect(splitFrontmatter('---\nname: x\n---\nbody\n---\nmore')).toEqual({
      frontmatter: 'name: x',
      body: 'body\n---\nmore',
    });
  });

  it('does not treat a bare trailing --- at EOF as a closing fence', () => {
    expect(splitFrontmatter('---\nname: x\n---')).toBeNull();
  });

  it('allows an empty body', () => {
    expect(splitFrontmatter('---\nname: x\n---\n')).toEqual({
      frontmatter: 'name: x',
      body: '',
    });
  });

  it('normalisation: two adjacent fences give an empty frontmatter', () => {
    // Documented behaviour change: the old regex could not match this shape
    // (the opening fence consumes the only newline before `---`), so callers
    // saw the whole document as the body. policies/shellm already behaved the
    // new way; skills/routines are now uniform with them.
    expect(PREVIOUS_REGEX.exec('---\n---\nrest')).toBeNull();
    expect(splitFrontmatter('---\n---\nrest')).toEqual({
      frontmatter: '',
      body: 'rest',
    });
  });

  it('agrees with the regex it replaced on well-formed documents', () => {
    const corpus = [
      '---\nname: x\n---\nbody',
      '---\nname: x\ndescription: y\n---\nbody line 1\nbody line 2',
      '---\nname: x\n---\n',
      '---  \nname: x\n---  \nbody',
      '---\r\nname: x\r\n---\r\nbody',
      '---\nname: x\n---\nbody\n---\nmore',
      '---\nname: "a: b"\n---\n  indented body  ',
      // Whitespace-only lines around the fences: the old `\s*\n` skipped
      // them, and the line scan reproduces that exactly.
      '---\n\nname: x\n---\nbody',
      '---\n   \nname: x\n---\n\n\nbody',
      '---\n  indented: y\n---\nbody',
      '---  \nname: x\n---  \nbody',
    ];
    for (const doc of corpus) {
      const m = PREVIOUS_REGEX.exec(doc);
      expect(m).not.toBeNull();
      expect(splitFrontmatter(doc)).toEqual({
        frontmatter: m![1],
        body: m![2],
      });
    }
  });

  it('parses a hostile document without backtracking', () => {
    // `\s*` next to a lazy `[\s\S]*?` is the js/polynomial-redos shape: a long
    // run of whitespace-only lines after the fence, with no closing fence.
    // Under the old regex this input is the pathological case; the line scan
    // is linear. If someone reintroduces a backtracking regex here, this test
    // stops finishing (and fails on the suite timeout) rather than hanging the
    // whole run.
    const hostile = '---\n' + ' \n'.repeat(120_000) + 'x';
    expect(splitFrontmatter(hostile)).toBeNull();
  });
});
