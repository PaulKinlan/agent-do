/**
 * The streamed answer on stdout (agent-do-ftb).
 *
 * Two properties, and they pull in opposite directions on purpose:
 *
 * 1. When stdout is a TERMINAL, model output must not be able to drive it. A terminal obeys control sequences, so
 *    an answer shaped by a hostile file/page/MCP response could write the operator's clipboard (OSC 52), rewrite
 *    the title, or use a bidi override to display a different path than the one printed.
 * 2. When stdout is NOT a terminal — `> answer.txt`, a pipe, a `--json` consumer — the bytes must be IDENTICAL.
 *    Stdout is a data channel too, and rewriting it to defend a stream nobody is looking at would silently change
 *    the product's output contract. A file does not obey escape sequences; it records them.
 *
 * Testing only (1) would let an over-eager fix (sanitise unconditionally) pass, and testing only (2) would let the
 * defect back in. The teeth below are therefore aimed at both.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { writeAnswerChunk } from '../src/cli/answer-stream.js';

const HOSTILE = 'answer \u001b]52;c;ZXZpbA==\u0007 and src/\u202Eevil.ts';
const OSC52_INTRODUCER = /\u001b\]52/;
const BIDI = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

describe('writeAnswerChunk', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let writeSpy: any;
  const isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

  function setTty(value: boolean | undefined): void {
    Object.defineProperty(process.stdout, 'isTTY', {
      value,
      configurable: true,
      writable: true,
    });
  }

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    if (isTtyDescriptor) Object.defineProperty(process.stdout, 'isTTY', isTtyDescriptor);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
  });

  const written = (): string => writeSpy.mock.calls.map((c: unknown[]) => c[0] as string).join('');

  it('neutralises control sequences when stdout is a terminal', () => {
    setTty(true);
    writeAnswerChunk(HOSTILE);
    const out = written();
    expect(out, 'the OSC 52 introducer survived into the terminal').not.toMatch(OSC52_INTRODUCER);
    expect(out, 'a raw bidi override reached the terminal').not.toMatch(BIDI);
    expect(out).toContain('[U+001B]');
    expect(out).toContain('[U+0007]');
    expect(out).toContain('[U+202E]');
    // The payload stays legible as inert text: the operator can see what was attempted.
    expect(out).toContain(']52;c;ZXZpbA==');
  });

  it('writes the bytes unchanged when stdout is redirected or piped', () => {
    setTty(undefined); // what a pipe/file looks like
    writeAnswerChunk(HOSTILE);
    expect(written()).toBe(HOSTILE);
  });

  it('treats isTTY: false the same as absent', () => {
    setTty(false);
    writeAnswerChunk(HOSTILE);
    expect(written()).toBe(HOSTILE);
  });

  it('leaves an ordinary answer byte-identical on a terminal too', () => {
    setTty(true);
    const ordinary = 'Here is the answer:\n\tindented ─── done 🚀\n';
    writeAnswerChunk(ordinary);
    expect(written()).toBe(ordinary);
  });
});

/**
 * Collect the argument text of every `process.stdout.write(...)` call in `source`.
 *
 * A depth scan that skips string literals, so a nested call or a multi-line argument is captured whole.
 */
function stdoutWriteArgs(source: string): string[] {
  const args: string[] = [];
  const needle = 'process.stdout.write(';
  let i = source.indexOf(needle);
  while (i !== -1) {
    let depth = 0;
    let j = i + needle.length - 1;
    let quote: string | null = null;
    let arg = '';
    for (; j < source.length; j++) {
      const ch = source[j];
      // Quoted content is PART of the argument: quote-awareness exists only so a paren inside a string literal is
      // not mistaken for structure. Dropping it (an earlier version of this helper did) made every literal argument
      // look empty, i.e. it failed the good cases rather than the bad one.
      if (quote) {
        arg += ch;
        if (ch === '\\') {
          arg += source[j + 1] ?? '';
          j++;
          continue;
        }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        arg += ch;
        continue;
      }
      if (ch === '(') {
        depth++;
        if (depth === 1) continue;
      }
      if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
      if (depth >= 1) arg += ch;
    }
    args.push(arg.trim());
    i = source.indexOf(needle, j);
  }
  return args;
}

/**
 * Acceptable argument shapes for a direct stdout write in `src/cli/`:
 * - a string literal, or a template with no interpolation (layout only: newlines, banners)
 * - `JSON.stringify(...)`: JSON escaping means no control byte reaches the terminal, and `--json` consumers want data
 * Everything else must go through `writeAnswerChunk`, so model-derived text cannot reach stdout by accident.
 */
function isSafeStdoutArg(arg: string): boolean {
  if (/^'(?:[^'\\]|\\.)*'$/.test(arg)) return true;
  if (/^"(?:[^"\\]|\\.)*"$/.test(arg)) return true;
  if (arg.startsWith('`') && !arg.includes('${')) return true;
  if (arg.startsWith('JSON.stringify(')) return true;
  return false;
}

describe('no CLI module writes model output straight to stdout', () => {
  // A source assertion, deliberately, and BROADENED after agent-do-wcq.
  //
  // The first version of this test matched `process.stdout.write(event.` and therefore could never see the
  // interactive loop, which assigns to a local `response` first: the invariant was narrower than its own name, so it
  // certified a property it did not check. Matching variable NAMES was the mistake. This version matches the SHAPE
  // of the argument instead: anything that is not a literal, a non-interpolated template, or JSON.stringify is model
  // data until proven otherwise, and must go through the one seam. That is checkable without knowing what a future
  // author will call their variable.
  //
  // It is also the one place a static rule is the right tool: the property is the ABSENCE of a pattern across every
  // file in src/cli/, which no runtime test can observe.
  it('only writes literals, JSON, or through writeAnswerChunk', () => {
    const dir = new URL('../src/cli/', import.meta.url);
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      if (file === 'answer-stream.ts') continue; // the seam itself: the only file allowed to write a variable
      const source = readFileSync(fileURLToPath(new URL(file, dir)), 'utf8');
      const stripped = source
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
        .join('\n');
      for (const arg of stdoutWriteArgs(stripped)) {
        if (!isSafeStdoutArg(arg)) offenders.push(`${file}: process.stdout.write(${arg})`);
      }
    }
    expect(offenders, 'these write non-literal data to stdout; route model output through writeAnswerChunk').toEqual(
      [],
    );
  });
});
