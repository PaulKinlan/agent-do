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
