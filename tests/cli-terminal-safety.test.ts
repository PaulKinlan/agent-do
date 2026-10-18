/**
 * Terminal safety for operator output (agent-do-9zk).
 *
 * These tests are about the *bytes*, not the wording: what must hold is that no control character or bidi
 * override survives into the string the CLI hands to `process.stderr.write`. Each case names the thing an
 * operator would otherwise suffer — clipboard overwrite, title rewrite, erased lines, a path that displays
 * as a different path — so a future edit that "cleans up" the sanitiser fails with a reason attached.
 */
import { describe, expect, it } from 'vitest';
import {
  isSingleLineUnsafe,
  isTerminalUnsafe,
  sanitiseForLine,
  sanitiseForTerminal,
  sanitiseRow,
} from '../src/cli/terminal-safety.js';

/** Every byte class the sanitiser must remove. */
const RAW = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

describe('sanitiseForTerminal', () => {
  it('neutralises an OSC 52 clipboard write by breaking its introducer', () => {
    // ESC ] 52 ; c ; <base64> BEL would put attacker-chosen text on the operator's clipboard.
    const out = sanitiseForTerminal('note \x1b]52;c;ZXZpbA==\x07 end');
    expect(out).not.toMatch(RAW);
    expect(out).toContain('[U+001B]');
    expect(out).toContain('[U+0007]');
    // The payload stays as inert, visible text: the operator can see what was attempted.
    expect(out).toContain(']52;c;ZXZpbA==');
  });

  it('neutralises a CSI erase-screen and cursor moves', () => {
    const out = sanitiseForTerminal('\x1b[2J\x1b[H\x1b[31mred\x1b[0m');
    expect(out).not.toMatch(RAW);
    expect(out).toContain('[U+001B]');
    expect(out).toContain('red');
  });

  it('neutralises the 8-bit C1 introducers as well as ESC', () => {
    // U+009B is CSI and U+009D is OSC in 8-bit form; a sanitiser that only knows about ESC leaves them raw.
    const out = sanitiseForTerminal('\u009b2J\u009d0;title\u009c');
    expect(out).not.toMatch(RAW);
    expect(out).toContain('[U+009B]');
    expect(out).toContain('[U+009D]');
    expect(out).toContain('[U+009C]');
  });

  it('neutralises bidi overrides so a path cannot display as a different path', () => {
    // The Trojan Source shape: RLO reverses the run, so what prints is not what was read.
    const out = sanitiseForTerminal('src/\u202Eevil.ts');
    expect(out).not.toMatch(RAW);
    expect(out).toContain('[U+202E]');
    expect(sanitiseForTerminal('\u2066isolate\u2069')).not.toMatch(RAW);
    expect(sanitiseForTerminal('\u200Fmark\u200E')).not.toMatch(RAW);
  });

  it('neutralises DEL and the remaining C0 controls including NUL', () => {
    expect(sanitiseForTerminal('a\u007Fb\u0000c\u0001d')).not.toMatch(RAW);
  });

  it('leaves layout characters and ordinary text alone', () => {
    // The renderer legitimately prints newlines and tabs, and box drawing / arrows are not controls.
    const text = 'a\tb\nc ─── → … 🚀 漢字';
    expect(sanitiseForTerminal(text)).toBe(text);
  });

  it('is idempotent, because the marker text contains no controls', () => {
    const once = sanitiseForTerminal('\x1b[2J\u202E');
    expect(sanitiseForTerminal(once)).toBe(once);
  });

  it('removes every raw byte class from a composed hostile payload', () => {
    const hostile =
      'summary: \x1b]0;pwned\x07\x1b[2J\x1b[8mhidden\x1b[0m \u202E…gm\u202C \u009b31m\u0000\u007F\n';
    const out = sanitiseForTerminal(hostile);
    expect(out).not.toMatch(RAW);
    expect(out.endsWith('\n')).toBe(true); // a trailing newline is the renderer's, and survives
  });
});

describe('the unsafe-character sets', () => {
  it('treats newline and tab as unsafe only inside a single line', () => {
    // Layout in a multi-line answer; a way to forge a second line inside a table cell or a diagnostic.
    expect(isTerminalUnsafe('\n')).toBe(false);
    expect(isSingleLineUnsafe('\n')).toBe(true);
    expect(isTerminalUnsafe('\t')).toBe(false);
    expect(isSingleLineUnsafe('\t')).toBe(true);
    for (const ch of ['\u001b', '\u009b', '\u202E', '\u2066', '\u007F']) {
      expect(isTerminalUnsafe(ch), ch).toBe(true);
      expect(isSingleLineUnsafe(ch), ch).toBe(true);
    }
    expect(isTerminalUnsafe('a')).toBe(false);
    expect(isSingleLineUnsafe('a')).toBe(false);
  });

  it('does not misclassify every second character', () => {
    // Both patterns are global, and a global regex remembers `lastIndex` between `test` calls. Without the reset in
    // the predicate, alternating characters would classify as safe/unsafe/safe - so this assertion is the guard for
    // a bug that looks like a passing test suite.
    const chars = ['\u001b', 'a', '\u001b', 'a', '\u202E', 'a', '\u202E'];
    expect(chars.map((c) => isTerminalUnsafe(c))).toEqual([true, false, true, false, true, false, true]);
  });
});

describe('sanitiseForLine / sanitiseRow (fields vs structure)', () => {
  it('turns newline, tab and bidi into ? in a field, and keeps the text', () => {
    // A field is one line: these are not layout here, they are a way to forge a row or a column.
    expect(sanitiseForLine('a\nb\tc\u202Ed')).toBe('a?b?c?d');
    expect(sanitiseForLine('\u001b]52;c;x\u0007')).toBe('?]52;c;x?');
    expect(sanitiseForLine('plain text — ok')).toBe('plain text — ok');
  });

  it('keeps the separator and suffix OURS while single-lining every cell', () => {
    const row = sanitiseRow(['sweep', '*/15 * * * *'], '\t', ' — ok\nforged');
    // Structure survives: one tab between the two cells, none inside them.
    expect(row.startsWith('sweep\t*/15 * * * *')).toBe(true);
    // A newline in any cell or the suffix cannot start a second line.
    expect(row).not.toContain('\n');
    expect(row).toContain(' — ok?forged');
  });

  it('single-lines every cell of a multi-column row', () => {
    const row = sanitiseRow(['id\nx', 'cron', 'last\r', 'out\tcome', 7]);
    expect(row).toBe('id?x\tcron\tlast?\tout?come\t7');
  });
});
