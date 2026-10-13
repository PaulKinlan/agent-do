import { describe, it, expect } from 'vitest';
import { splitFrontmatter } from '../src/frontmatter.js';
import { parseSkillMd } from '../src/skills.js';
import { parseRoutineMd } from '../src/routines.js';

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

  it('requires the opening fence to be the dashes themselves', () => {
    // Regression guard (found by the 6bu review): the scan reads its whitespace
    // run from index 3, so it must check the dashes first. Without that check
    // any 3-character first line — `Run`, `## `, `# x`, `ab ` — was treated as
    // a fence whenever a later line was `---`, silently cutting the document in
    // half and feeding the first lines to the YAML parser.
    expect(splitFrontmatter('Run\nthe analysis\n---\ndetails')).toBeNull();
    expect(splitFrontmatter('ab \ncd\n---\nbody')).toBeNull();
    expect(splitFrontmatter('## \nbody\n---\nmore')).toBeNull();
    expect(splitFrontmatter('--\nname: x\n---\nbody')).toBeNull();
    expect(splitFrontmatter('---x\nname: y\n---\nbody')).toBeNull();
  });

  it('does not split a real document whose first line is short text plus a --- line', () => {
    // End-to-end form of the guard above: the callers must keep the whole
    // document as the body and report no metadata.
    const doc = 'Run\nthe analysis\n---\ndetails';
    expect(parseRoutineMd(doc, 'demo-routine').body).toContain('Run');
    expect(parseSkillMd(doc, 'demo-skill').content).toContain('Run');
  });

  it('accepts trailing whitespace on either fence', () => {
    expect(splitFrontmatter('---  \nname: x\n---\t\nbody')).toEqual({
      frontmatter: 'name: x',
      body: 'body',
    });
  });

  it('accepts any non-newline whitespace on the closing fence, as the old regex did', () => {
    // `\n---\s*\n` allowed the whole `\s` set before the newline. Narrowing it
    // to space/tab/CR made these documents lose their metadata silently.
    for (const ch of ['\u00a0', '\u000b', '\u000c', '\u2028', '\ufeff', '\u2003']) {
      expect(splitFrontmatter(`---\nname: x\n---${ch}\nbody`)).toEqual({
        frontmatter: 'name: x',
        body: 'body',
      });
    }
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

  it('skips an empty fence when a later fence closes the real frontmatter', () => {
    // agent-do-432 (found by the round-2 review of this branch): the second
    // fence here is YAML's own document marker, so closing on it would push the
    // metadata into the body and parse nothing. The old regex could not close
    // there either, and the scan now matches it exactly.
    const doc = '---\n\n---\nname: valid\ndescription: enabled\n---\nbody';
    expect(PREVIOUS_REGEX.exec(doc)!.slice(1)).toEqual([
      '---\nname: valid\ndescription: enabled',
      'body',
    ]);
    expect(splitFrontmatter(doc)).toEqual({
      frontmatter: '---\nname: valid\ndescription: enabled',
      body: 'body',
    });
  });

  it('parses the metadata that follows a blank line and a fence (agent-do-432 end to end)', () => {
    const doc = '---\n\n---\nname: valid\ndescription: enabled\n---\nbody';
    const skill = parseSkillMd(doc, 'fallback-id');
    expect(skill.name).toBe('valid');
    expect(skill.description).toBe('enabled');
    expect(skill.content).toBe('body');

    const routine = parseRoutineMd(doc, 'fallback-id');
    expect(routine.name).toBe('valid');
    expect(routine.description).toBe('enabled');
    expect(routine.body).toBe('body');
  });

  it('normalisation: two adjacent fences with no later fence give an empty frontmatter', () => {
    // The one remaining *observable* difference, and it is a body change: the
    // regex found no closing fence here at all, so callers kept the whole
    // document — fence lines included — as the body, while the scan returns an
    // empty frontmatter and `rest` as the body. `parsePolicyMd` and `.shellm`
    // already behaved the scanner's way.
    expect(PREVIOUS_REGEX.exec('---\n---\nrest')).toBeNull();
    expect(splitFrontmatter('---\n---\nrest')).toEqual({
      frontmatter: '',
      body: 'rest',
    });
  });

  it('prefers a later fence after blank lines before the first content fence', () => {
    // Same mechanism as the agent-do-432 case, one line further out, and here
    // the scan and the regex agree exactly.
    expect(PREVIOUS_REGEX.exec('---\n\n---\nline 1\n---\nline 2')!.slice(1)).toEqual([
      '---\nline 1',
      'line 2',
    ]);
    expect(splitFrontmatter('---\n\n---\nline 1\n---\nline 2')).toEqual({
      frontmatter: '---\nline 1',
      body: 'line 2',
    });
  });

  it('documented difference: a whitespace-only frontmatter collapses to an empty string', () => {
    // Unobservable: every caller YAML-parses the frontmatter, and
    // `YAML.parse(' ')` and `YAML.parse('')` are both "no metadata". The old
    // regex kept the space because it backtracked; the scan commits to the
    // maximal skip.
    expect(PREVIOUS_REGEX.exec('---\n \n---\nbody')![1]).toBe(' ');
    expect(splitFrontmatter('---\n \n---\nbody')).toEqual({
      frontmatter: '',
      body: 'body',
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
      '---\nname: x\n---\u00a0\nbody',
      '---\nname: x\n---\u000b\nbody',
      '---\nname: x\n---\ufeff\nbody',
      '---\u00a0\nname: x\n---\nbody',
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
