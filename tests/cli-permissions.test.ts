import { describe, it, expect, vi } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { PassThrough } from 'node:stream';
import { parseArgs } from '../src/cli/args.js';
import {
  buildCliPermissions,
  READ_ONLY_TOOLS,
} from '../src/cli/permission-handler.js';
import { evaluatePermission } from '../src/permissions.js';

// ─── #17 C-01: flag parsing ─────────────────────────────────────────────

describe('parseArgs: --accept-all / --yes / --allow', () => {
  it('defaults to acceptAll=false, allow=[]', () => {
    const args = parseArgs([]);
    expect(args.acceptAll).toBe(false);
    expect(args.allow).toEqual([]);
  });

  it('parses --accept-all, --yes, -y as aliases', () => {
    expect(parseArgs(['--accept-all']).acceptAll).toBe(true);
    expect(parseArgs(['--yes']).acceptAll).toBe(true);
    expect(parseArgs(['-y']).acceptAll).toBe(true);
  });

  it('parses --allow as a comma-separated list', () => {
    const args = parseArgs(['--allow', 'write_file,memory_write']);
    expect(args.allow).toEqual(['write_file', 'memory_write']);
  });
});

// ─── #17 C-01: buildCliPermissions ──────────────────────────────────────

describe('buildCliPermissions', () => {
  // Helpers that simulate a TTY stdin and capture stderr writes.
  function mockStdin(isTTY: boolean, answers: string[] = []): NodeJS.ReadStream {
    // Vitest / node readline uses `createInterface({ input })`. The
    // interface reads line-by-line from the stream. Feed ONE answer per
    // read(): pushing every line at once let the first readline interface
    // eagerly swallow all buffered lines, starving a SECOND prompt created
    // by a later onPermissionRequest call (agent-do-ulkp exercises exactly
    // that: approve one call, then re-prompt for a different call).
    let next = 0;
    let ended = false;
    const r = new Readable({
      read(this: Readable) {
        if (next < answers.length) {
          this.push(answers[next++] + '\n');
        } else if (!ended) {
          ended = true;
          this.push(null);
        }
      },
    });
    (r as unknown as { isTTY: boolean }).isTTY = isTTY;
    return r as unknown as NodeJS.ReadStream;
  }

  function mockStderr(
    isTTY = true,
  ): { stream: NodeJS.WriteStream; written: string[] } {
    const written: string[] = [];
    const w = new Writable({
      write(chunk: Buffer | string, _enc, cb) {
        written.push(chunk.toString());
        cb();
      },
    });
    (w as unknown as { isTTY: boolean }).isTTY = isTTY;
    return { stream: w as unknown as NodeJS.WriteStream, written };
  }

  it('--accept-all returns { mode: "accept-all" }', () => {
    const cfg = buildCliPermissions({ acceptAll: true, allow: [] });
    expect(cfg.mode).toBe('accept-all');
  });

  it('default is mode: "ask" with a prompt handler', () => {
    const cfg = buildCliPermissions({ acceptAll: false, allow: [] });
    expect(cfg.mode).toBe('ask');
    expect(typeof cfg.onPermissionRequest).toBe('function');
  });

  it('--allow seeds per-tool "always" entries', () => {
    const cfg = buildCliPermissions({
      acceptAll: false,
      allow: ['write_file', 'delete_file'],
    });
    expect(cfg.tools?.write_file).toBe('always');
    expect(cfg.tools?.delete_file).toBe('always');
  });

  it('auto-approves read-only tools without prompting', async () => {
    const { stream: stderr, written } = mockStderr();
    const cfg = buildCliPermissions({
      acceptAll: false,
      allow: [],
      stdin: mockStdin(true, []),
      stderr,
    });
    for (const tool of READ_ONLY_TOOLS) {
      const ok = await cfg.onPermissionRequest!({ toolName: tool, args: {} });
      expect(ok).toBe(true);
    }
    // No prompt should have been written.
    expect(written.join('')).toBe('');
  });

  it('denies destructive tools in non-TTY mode (fail closed)', async () => {
    const { stream: stderr, written } = mockStderr();
    const cfg = buildCliPermissions({
      acceptAll: false,
      allow: [],
      stdin: mockStdin(false),
      stderr,
    });
    const ok = await cfg.onPermissionRequest!({
      toolName: 'write_file',
      args: { path: 'a.txt' },
    });
    expect(ok).toBe(false);
    expect(written.join('')).toMatch(/non-interactive/);
  });

  it('denies when stderr is redirected even if stdin is a TTY (Codex #68 P2)', async () => {
    // If only stdin is a TTY but stderr is piped to a file (common:
    // `agent-do ... 2>log`), the prompt goes to the log and the
    // operator appears to see the agent hang. Fail closed.
    const { stream: stderr, written } = mockStderr(false);
    const cfg = buildCliPermissions({
      acceptAll: false,
      allow: [],
      stdin: mockStdin(true, ['y']), // would answer yes if we prompted
      stderr,
    });
    const ok = await cfg.onPermissionRequest!({
      toolName: 'write_file',
      args: { path: 'a.txt' },
    });
    expect(ok).toBe(false);
    expect(written.join('')).toMatch(/non-interactive/);
  });

  it('prompts on TTY and approves on "y"', async () => {
    const { stream: stderr } = mockStderr();
    const cfg = buildCliPermissions({
      acceptAll: false,
      allow: [],
      stdin: mockStdin(true, ['y']),
      stderr,
    });
    const ok = await cfg.onPermissionRequest!({
      toolName: 'write_file',
      args: { path: 'a.txt' },
    });
    expect(ok).toBe(true);
  });

  it('prompts on TTY and denies on "n"', async () => {
    const { stream: stderr } = mockStderr();
    const cfg = buildCliPermissions({
      acceptAll: false,
      allow: [],
      stdin: mockStdin(true, ['n']),
      stderr,
    });
    const ok = await cfg.onPermissionRequest!({
      toolName: 'delete_file',
      args: { path: 'x' },
    });
    expect(ok).toBe(false);
  });

  it('"always" caches the exact call and re-prompts on different args (agent-do-ulkp)', async () => {
    const { stream: stderr } = mockStderr();
    // A PassThrough stream so the test writes each answer exactly when its prompt is pending —
    // the push-everything mock lets the first readline eagerly swallow lines meant for a later prompt.
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    (stdin as unknown as { isTTY: boolean }).isTTY = true;
    const cfg = buildCliPermissions({
      acceptAll: false,
      allow: [],
      stdin,
      stderr,
    });
    const call = (args: Record<string, unknown>) =>
      cfg.onPermissionRequest!({ toolName: 'write_file', args });

    // First call: answer "always".
    const p1 = call({ path: 'a', content: 'hello' });
    stdin.write('always\n');
    expect(await p1).toBe(true);

    // Identical call (key order too): auto-approved from the cache, no prompt, no stdin needed.
    expect(await call({ content: 'hello', path: 'a' })).toBe(true);

    // Different args: must re-prompt — the old tool-name grant made this call silent.
    const p3 = call({ path: 'a', content: 'DIFFERENT' });
    stdin.write('y\n');
    expect(await p3).toBe(true);

    // Same tool, different shape AGAIN: prompts once more (answers exhausted -> we only check it
    // consumed the prompt by answering 'n').
    const p4 = call({ path: 'zz' });
    stdin.write('n\n');
    expect(await p4).toBe(false);

    stdin.end();
  });

  it('previews long args with head AND tail, keeping every key visible (agent-do-ulkp)', async () => {
    const { stream: stderr, written } = mockStderr();
    const stdin = mockStdin(true, ['n']);
    const cfg = buildCliPermissions({
      acceptAll: false,
      allow: [],
      stdin,
      stderr,
    });
    const huge = 'a'.repeat(500);
    await cfg.onPermissionRequest!({
      toolName: 'write_file',
      args: { content: huge },
    });
    const promptText = written.join('');
    expect(promptText).toMatch(/write_file\(/);
    // Long value: head kept, tail kept, length disclosed — neither end hidden.
    expect(promptText).toContain('…[500 chars]…');
    expect(promptText).toContain('aaaa');
    // The 500 'a's must NOT be fully inlined (bounded prompt), but the preview is not capped
    // at an overall 120 chars that could hide later keys.
    expect(promptText).not.toContain(huge);
  });

  it('truncates per-value, not just the final string (Copilot #68)', async () => {
    // A write_file with a 1 MB `content` argument used to be fully
    // stringified before truncation — allocating ~1 MB just to slice
    // it. The new implementation caps each string leaf at 80 chars
    // via a JSON.stringify replacer so large payloads never enter
    // the final buffer.
    const { stream: stderr, written } = mockStderr();
    const stdin = mockStdin(true, ['n']);
    const cfg = buildCliPermissions({
      acceptAll: false,
      allow: [],
      stdin,
      stderr,
    });
    const megabyte = 'x'.repeat(1024 * 1024);
    await cfg.onPermissionRequest!({
      toolName: 'write_file',
      args: { path: 'a.txt', content: megabyte },
    });
    const promptText = written.join('');
    // The prompt must stay bounded even though the value was 1 MB.
    expect(promptText.length).toBeLessThan(500);
    // The path must still be visible (not truncated to an ellipsis).
    expect(promptText).toContain('a.txt');
  });
});

// ─── #17 C-01: evaluatePermission end-to-end ────────────────────────────

describe('buildCliPermissions + evaluatePermission integration', () => {
  it('--allow entries skip the prompt via tools[...] = "always"', async () => {
    const cfg = buildCliPermissions({
      acceptAll: false,
      allow: ['write_file'],
    });
    // The per-tool "always" is checked before `onPermissionRequest`, so
    // the handler (which would deny in non-TTY) is never invoked.
    const ok = await evaluatePermission('write_file', { path: 'x' }, cfg);
    expect(ok).toBe(true);
  });

  it('--accept-all lets every tool through', async () => {
    const cfg = buildCliPermissions({ acceptAll: true, allow: [] });
    expect(await evaluatePermission('write_file', {}, cfg)).toBe(true);
    expect(await evaluatePermission('delete_file', {}, cfg)).toBe(true);
  });
});

describe('the interactive prompt neutralises control sequences (agent-do-193)', () => {
  // Same harness as above: a fake TTY stdin we can answer, and a writable stderr we can read back.
  function mockStdin(isTTY: boolean, answers: string[] = []): NodeJS.ReadStream {
    const r = new Readable({
      read() {
        for (const ans of answers) this.push(ans + '\n');
        this.push(null);
      },
    });
    (r as unknown as { isTTY: boolean }).isTTY = isTTY;
    return r as unknown as NodeJS.ReadStream;
  }
  function mockStderr(isTTY = true): { stream: NodeJS.WriteStream; written: string[] } {
    const written: string[] = [];
    const w = new Writable({
      write(chunk: Buffer | string, _enc, cb) {
        written.push(chunk.toString());
        cb();
      },
    });
    (w as unknown as { isTTY: boolean }).isTTY = isTTY;
    return { stream: w as unknown as NodeJS.WriteStream, written };
  }

  it('sanitises the tool name and the argument preview in the approval question', async () => {
    const { stream: stderr, written } = mockStderr(true);
    const stdin = mockStdin(true, ['n']);
    const cfg = buildCliPermissions({ acceptAll: false, allow: [], stdin, stderr });
    const ok = await cfg.onPermissionRequest!({
      toolName: 'shell\u001b]52;c;ZXZpbA==\u0007',
      args: { cmd: 'src/\u202Eevil.ts' },
    });
    expect(ok).toBe(false); // the answer still works
    const out = written.join('');
    // NOTE on why this does not assert "no ESC anywhere": readline emits its OWN cursor/erase sequences to the
    // output stream while editing the line (`\u001b[1G\u001b[0J` and friends). Asserting a blanket absence would
    // therefore test readline, and would fail for the wrong reason. What must hold is that OUR text cannot carry
    // the attack: the OSC 52 introducer is broken, the payload is inert, and bidi (which readline never emits)
    // is gone entirely.
    expect(out, 'the OSC 52 introducer survived').not.toMatch(/\u001b\]52/);
    expect(out, 'a raw bidi override reached the prompt').not.toMatch(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/);
    expect(out).toContain('[U+001B]');
    expect(out).toContain('[U+0007]');
    expect(out).toContain('[U+202E]');
    expect(out).toContain('Allow?'); // the question is still legible
  });

  it('leaves an ordinary prompt readable', async () => {
    const { stream: stderr, written } = mockStderr(true);
    const stdin = mockStdin(true, ['y']);
    const cfg = buildCliPermissions({ acceptAll: false, allow: [], stdin, stderr });
    const ok = await cfg.onPermissionRequest!({ toolName: 'write_file', args: { path: 'a.txt' } });
    expect(ok).toBe(true);
    const out = written.join('');
    expect(out).toContain('Agent wants to call write_file');
    expect(out).not.toContain('[U+');
  });
});
