/**
 * The streamed answer on stdout, exercised through the REAL prompt path (agent-do-ftb).
 *
 * `tests/cli-answer-stream.test.ts` proves `writeAnswerChunk` works; it does not prove that `src/cli/prompt.ts`
 * calls it. That gap is exactly what the fast gate refused to accept — `src/cli/prompt.ts` mapped to no suite —
 * and it was right to: a helper with a passing test and no call site is a fix that can silently evaporate. So this
 * test runs `runPromptMode` itself and reads what actually reaches stdout.
 *
 * The model is the repo's own `createMockModel`, injected by mocking `resolve-model`, so there is no network, no
 * API key and no provider SDK in the loop; what is real is everything between the CLI's argument handling and the
 * stdout write.
 *
 * Both directions matter (see the helper test): a terminal must not be driven by model output, and a pipe or
 * redirect must receive the bytes unchanged.
 */
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/cli/args.js';
import { runPromptMode } from '../src/cli/prompt.js';

const HOSTILE = 'answer \u001b]52;c;ZXZpbA==\u0007 and src/\u202Eevil.ts';
const OSC52_INTRODUCER = /\u001b\]52/;
const BIDI = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

// `vi.hoisted` hands the mock factory a value each case can set; `vi.mock` is hoisted above the imports, so the
// factory imports `createMockModel` dynamically rather than closing over the module binding.
const mockState = vi.hoisted(() => ({ text: '' }));
vi.mock('../src/cli/resolve-model.js', async () => {
  const { createMockModel } = await import('../src/testing/index.js');
  return {
    resolveModel: async () => createMockModel({ responses: [{ text: mockState.text }] }),
  };
});

describe('runPromptMode writes the streamed answer through the sanitiser (agent-do-ftb)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let writeSpy: any;
  const stdoutTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const stdinTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');

  function setStdoutTty(value: boolean | undefined): void {
    Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true, writable: true });
  }

  async function run(text: string): Promise<void> {
    mockState.text = text;
    await runPromptMode(parseArgs(['hi', '--provider', 'mock', '--model', 'mock-model', '--no-tools']));
  }

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // `runPromptMode` merges piped stdin unless stdin is a TTY (`readStdin` returns early only in that case) and
    // vitest's stdin is a pipe that never ends, so without this the run blocks until the test times out. A TTY
    // stdin is also the realistic shape here: these tests are about an operator watching the answer, whether or
    // not stdout itself is redirected.
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true, writable: true });
  });

  afterEach(() => {
    writeSpy.mockRestore();
    if (stdoutTtyDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutTtyDescriptor);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
    const current = process.stdin as unknown as { destroy?: () => void };
    if (typeof current.destroy === 'function') current.destroy();
    if (stdinDescriptor) Object.defineProperty(process, 'stdin', stdinDescriptor);
    if (stdinTtyDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinTtyDescriptor);
    else Reflect.deleteProperty(process.stdin, 'isTTY');
  });

  const written = (): string => writeSpy.mock.calls.map((c: unknown[]) => c[0] as string).join('');

  it('neutralises a hostile answer on a terminal, through the real call site', async () => {
    setStdoutTty(true);
    await run(HOSTILE);
    const out = written();
    expect(out, 'the model answer never reached stdout').toContain('answer');
    expect(out, 'the OSC 52 introducer survived into the terminal').not.toMatch(OSC52_INTRODUCER);
    expect(out, 'a raw bidi override reached the terminal').not.toMatch(BIDI);
    expect(out).toContain('[U+001B]');
    expect(out).toContain('[U+202E]');
  }, 20_000);

  it('writes the bytes unchanged when stdout is a pipe', async () => {
    setStdoutTty(undefined);
    await run(HOSTILE);
    expect(written(), 'piped output must stay byte-identical').toContain(HOSTILE);
  }, 20_000);

  it('leaves an ordinary answer byte-identical on a terminal', async () => {
    setStdoutTty(true);
    const ordinary = 'Here is the answer.';
    await run(ordinary);
    expect(written()).toContain(ordinary);
    expect(written()).not.toContain('[U+');
  }, 20_000);

  it('neutralises the answer in INTERACTIVE mode, which is a separate streaming loop', async () => {
    // agent-do-wcq: interactive mode is entered when there is no prompt and no piped stdin, and it assigns the
    // answer to a local before writing it - so neither the helper test nor a `stdout.write(event.` pattern could
    // ever have seen it. Driving it for real is the only honest proof, so stdin is swapped for a scripted one.
    setStdoutTty(true);
    // Both answers are buffered up front but the stream is never ENDED: `Readable.from` ends immediately, and
    // readline closes on 'end' before the model stream has finished the first turn, so the second `question()` call
    // rejects with "readline was closed". A PassThrough that stays open feeds them in order instead.
    const scripted = new PassThrough();
    Object.defineProperty(scripted, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process, 'stdin', { value: scripted, configurable: true });
    mockState.text = HOSTILE;
    scripted.write('hi\n');

    // `exit` is written only once the first answer has actually been printed. readline emits each line as it arrives
    // and drops any line with no pending `question()`, so writing both up front loses the second one and the loop
    // waits forever. `vi.waitFor` bounds the wait instead of sleeping.
    const running = runPromptMode(parseArgs(['--provider', 'mock', '--model', 'mock-model', '--no-tools']));
    await vi.waitFor(
      () => {
        expect(written(), 'the first answer never arrived').toContain('answer');
      },
      { timeout: 10_000 },
    );
    scripted.write('exit\n');
    await running;

    const out = written();
    expect(out, 'the interactive answer never reached stdout').toContain('answer');
    expect(out, 'the OSC 52 introducer survived into the interactive terminal').not.toMatch(OSC52_INTRODUCER);
    expect(out, 'a raw bidi override reached the interactive terminal').not.toMatch(BIDI);
    expect(out).toContain('[U+001B]');
    expect(out).toContain('[U+202E]');
  }, 20_000);
});
