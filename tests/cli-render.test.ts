import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderEvent, renderOptionsFromArgs } from '../src/cli/render.js';
import type { ProgressEvent } from '../src/types.js';
import type { ParsedArgs } from '../src/cli/args.js';

function makeArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command: 'prompt',
    provider: 'anthropic',
    systemPrompt: '',
    workingDir: process.cwd(),
    memoryDir: '.agent-do',
    withMemory: false,
    readOnly: false,
    maxIterations: 20,
    noTools: false,
    verbose: false,
    showContent: false,
    json: false,
    help: false,
    exclude: [],
    includeSensitive: false,
    output: 'console',
    concurrency: 1,
    ...overrides,
  };
}

describe('renderOptionsFromArgs', () => {
  it('copies verbose + showContent verbatim', () => {
    expect(renderOptionsFromArgs(makeArgs())).toEqual({ verbose: false, showContent: false });
    expect(renderOptionsFromArgs(makeArgs({ verbose: true }))).toEqual({ verbose: true, showContent: false });
    expect(renderOptionsFromArgs(makeArgs({ showContent: true, verbose: true }))).toEqual({ verbose: true, showContent: true });
  });
});

describe('renderEvent', () => {
  // Vitest's `vi.spyOn` return type doesn't simplify well for overloaded
  // signatures like `process.stderr.write`; type as `any` to keep the
  // test concise.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
  });

  const toolResult = (overrides: Partial<ProgressEvent>): ProgressEvent => ({
    type: 'tool-result',
    content: '',
    toolName: 'read_file',
    summary: '[read_file] src/app.ts — 1254 bytes, 42 lines',
    data: { path: 'src/app.ts', bytes: 1254, lines: 42 },
    step: 0,
    totalSteps: 20,
    ...overrides,
  });

  it('stays silent in quiet mode for thinking/tool-call/tool-result', () => {
    const { handled: t } = renderEvent({ type: 'thinking', content: 'step 1...' } as ProgressEvent, { verbose: false, showContent: false });
    expect(t).toBe(true);
    expect(stderrSpy).not.toHaveBeenCalled();

    const { handled: c } = renderEvent({ type: 'tool-call', content: '', toolName: 'read_file', toolArgs: { path: 'x' } } as ProgressEvent, { verbose: false, showContent: false });
    expect(c).toBe(true);
    expect(stderrSpy).not.toHaveBeenCalled();

    renderEvent(toolResult({}), { verbose: false, showContent: false });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('renders a structured tool-result summary in verbose mode', () => {
    renderEvent(toolResult({}), { verbose: true, showContent: false });
    const calls = stderrSpy.mock.calls.map((c: unknown[]) => c[0] as string).join('');
    expect(calls).toContain('[result]');
    expect(calls).toContain('[read_file] src/app.ts');
    expect(calls).toContain('data: ');
    expect(calls).toContain('bytes=1254');
    expect(calls).toContain('lines=42');
  });

  it('prefixes blocked results with [blocked]', () => {
    renderEvent(
      toolResult({
        blocked: true,
        summary: '[read_file] .env — BLOCKED by deny list (.env*)',
        data: { blocked: true, reason: 'deny-list', rule: '.env*' },
      }),
      { verbose: true, showContent: false },
    );
    const calls = stderrSpy.mock.calls.map((c: unknown[]) => c[0] as string).join('');
    expect(calls).toContain('[blocked]');
    expect(calls).toContain('rule=.env*');
  });

  it('does not include content by default', () => {
    renderEvent(
      toolResult({
        toolResult: { modelContent: 'SECRET_TOKEN=abc123', userSummary: 'x', data: {} },
      }),
      { verbose: true, showContent: false },
    );
    const calls = stderrSpy.mock.calls.map((c: unknown[]) => c[0] as string).join('');
    expect(calls).not.toContain('SECRET_TOKEN');
  });

  it('includes content when showContent=true', () => {
    renderEvent(
      toolResult({
        toolResult: { modelContent: 'hello\nworld', userSummary: 'x', data: {} },
      }),
      { verbose: true, showContent: true },
    );
    const calls = stderrSpy.mock.calls.map((c: unknown[]) => c[0] as string).join('');
    expect(calls).toContain('─── content ───');
    expect(calls).toContain('hello');
    expect(calls).toContain('world');
  });

  it('returns unhandled for done events so the caller prints the final answer', () => {
    const { handled } = renderEvent({ type: 'done', content: 'Final answer' } as ProgressEvent, { verbose: false, showContent: false });
    expect(handled).toBe(false);
  });

  it('prints errors to stderr and returns unhandled so the caller can set a non-zero exit code', () => {
    // Regression guard: PR #53 originally consumed errors as handled,
    // which made CI runs return exit code 0 on aborts / spending-limit /
    // max-iteration failures. Codex flagged it; the renderer now writes
    // to stderr but returns unhandled so the caller can `process.exit(1)`.
    const { handled } = renderEvent(
      { type: 'error', content: 'oops' } as ProgressEvent,
      { verbose: false, showContent: false },
    );
    const calls = stderrSpy.mock.calls.map((c: unknown[]) => c[0] as string).join('');
    expect(calls).toContain('Error: oops');
    expect(handled).toBe(false);
  });
});
