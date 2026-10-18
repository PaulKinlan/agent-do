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

/** Known-sanitised wrappers: their result cannot carry a raw terminal control sequence. */
const SAFE_WRAPPERS = [
  'JSON.stringify(',
  'printable(',
  'sanitiseForTerminal(',
  'sanitiseForStream(',
  'writeAnswerChunk(',
  'writeOperatorLine(',
];

const startsWithSafeWrapper = (expr: string): boolean => SAFE_WRAPPERS.some((w) => expr.startsWith(w));

/** Every `${...}` expression inside a template literal, with nested braces and string literals respected. */
function interpolations(templateArg: string): string[] {
  const found: string[] = [];
  let i = 0;
  while (i < templateArg.length) {
    const at = templateArg.indexOf('${', i);
    if (at === -1) return found;
    let depth = 1;
    let j = at + 2;
    let quote: string | null = null;
    while (j < templateArg.length && depth > 0) {
      const ch = templateArg[j];
      if (quote) {
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (ch === quote) quote = null;
        j += 1;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        j += 1;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      j += 1;
    }
    found.push(templateArg.slice(at + 2, j - 1).trim());
    i = j;
  }
  return found;
}

/**
 * Acceptable argument shapes for operator-facing stdout (agent-do-bc4):
 * - a string literal
 * - a template with no interpolation (layout only: newlines, banners)
 * - a call to a known sanitiser/encoder, whole-line
 * - a template whose EVERY interpolation is itself a sanitiser call
 * Anything else - any bare variable, any arithmetic, any unsanitised interpolation - is model/config data until
 * proven otherwise and must be wrapped or routed through the seam.
 */
function isSafeStdoutArg(arg: string): boolean {
  // A blank line: `console.log()` is layout, not data.
  if (arg === '') return true;
  // Machine-format output is DATA, not operator-facing text: `--json`, the CSV eval rows, and the crontab lines
  // `scheduled-tasks install` emits. Escaping belongs to the format (JSON does it; a CSV cell and a crontab line are
  // read by a parser, not a terminal). The human-readable versions of the same content go through the renderer.
  if (/^(?:JSON\.stringify|lines\.join|[A-Za-z_$][\w$]*\.join)\(/.test(arg)) return true;
  if (/^'(?:[^'\\]|\\.)*'$/.test(arg)) return true;
  if (/^"(?:[^"\\]|\\.)*"$/.test(arg)) return true;
  if (startsWithSafeWrapper(arg)) return true;
  if (!arg.startsWith('`')) return false;
  const parts = interpolations(arg);
  return parts.every((expr) => startsWithSafeWrapper(expr));
}

/** `process.stdout.write`, `console.log`, `console.info` and `console.debug` are the same channel (agent-do-bc4). */
const STDOUT_CALL = /(?:process\.stdout\.write|console\.(?:log|info|debug))\(/;

function stdoutCalls(source: string): Array<{ api: string; arg: string }> {
  const calls: Array<{ api: string; arg: string }> = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(STDOUT_CALL.source, 'g');
  while ((m = re.exec(source)) !== null) {
    const openParen = m.index + m[0].length - 1;
    let depth = 0;
    let j = openParen;
    let quote: string | null = null;
    let arg = '';
    for (; j < source.length; j++) {
      const ch = source[j];
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
    calls.push({ api: m[0].slice(0, -1), arg: arg.trim() });
    re.lastIndex = j;
  }
  return calls;
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
      for (const { api, arg } of stdoutCalls(stripped)) {
        if (!isSafeStdoutArg(arg)) offenders.push(`${file}: ${api}(${arg})`);
      }
    }
    expect(offenders, 'these write non-literal data to stdout; route model output through writeAnswerChunk').toEqual(
      [],
    );
  });
});
