import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { emitSandboxWarning } from '../src/cli/warnings.js';

describe('emitSandboxWarning', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('warns in the default configuration', () => {
    emitSandboxWarning({ toolsEnabled: true, readOnly: false, json: false });
    const message = stderrSpy.mock.calls.map((c: unknown[]) => c[0] as string).join('');
    expect(message).toMatch(/not sandboxed/);
    expect(message).toMatch(/working directory/);
    expect(message).toMatch(/--read-only/);
    expect(message).toMatch(/--no-tools/);
  });

  it('still warns in read-only mode, but with adjusted wording', () => {
    // Codex P2 + Copilot both flagged that the original
    // "suppressed when read-only" behaviour hid a real privacy
    // surface — read-only still leaks file contents to the model
    // provider via read/list/grep. Now we warn with adjusted wording.
    emitSandboxWarning({ toolsEnabled: true, readOnly: true, json: false });
    const message = stderrSpy.mock.calls.map((c: unknown[]) => c[0] as string).join('');
    expect(message).toMatch(/read-only/);
    expect(message).toMatch(/Writes are blocked/);
    expect(message).toMatch(/read.*list.*grep/);
  });

  it('stays silent when tools are disabled', () => {
    emitSandboxWarning({ toolsEnabled: false, readOnly: false, json: false });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('stays silent in --json mode to keep programmatic consumers clean', () => {
    emitSandboxWarning({ toolsEnabled: true, readOnly: false, json: true });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('regression: warns on resolved tool-config truth, not raw CLI args', () => {
    // Codex P2 on PR #47: `npx agent-do run <saved> --no-tools` could
    // suppress the warning while a saved agent with `noTools: false`
    // still ran with full file access. The fix made the API take an
    // explicit `toolsEnabled` boolean computed by the caller from the
    // resolved config — this test asserts the API enforces that
    // contract by behaving on `toolsEnabled`, not on any args proxy.
    emitSandboxWarning({ toolsEnabled: true, readOnly: false, json: false });
    expect(stderrSpy).toHaveBeenCalledOnce();
  });
});
