import { describe, it, expect, vi } from 'vitest';
import { Readable, Writable } from 'node:stream';
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
    // interface reads line-by-line from the stream. Feed the answers
    // as separate lines. The Readable implementation below is the
    // standard "push strings then null to end" pattern.
    const r = new Readable({
      read() {
        for (const ans of answers) this.push(ans + '\n');
        this.push(null);
      },
    });
    (r as unknown as { isTTY: boolean }).isTTY = isTTY;
    return r as unknown as NodeJS.ReadStream;
  }

  function mockStderr(): { stream: NodeJS.WriteStream; written: string[] } {
    const written: string[] = [];
    const w = new Writable({
      write(chunk: Buffer | string, _enc, cb) {
        written.push(chunk.toString());
        cb();
      },
    });
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

  it('"always" caches approval for the rest of the session', async () => {
    const { stream: stderr } = mockStderr();
    // Three calls: first answers "always", next two should not prompt.
    const stdin = mockStdin(true, ['always']);
    const cfg = buildCliPermissions({
      acceptAll: false,
      allow: [],
      stdin,
      stderr,
    });
    const first = await cfg.onPermissionRequest!({
      toolName: 'write_file',
      args: { path: 'a' },
    });
    expect(first).toBe(true);
    // Subsequent calls should auto-approve — no stdin line consumed.
    const second = await cfg.onPermissionRequest!({
      toolName: 'write_file',
      args: { path: 'b' },
    });
    const third = await cfg.onPermissionRequest!({
      toolName: 'write_file',
      args: { path: 'c' },
    });
    expect(second).toBe(true);
    expect(third).toBe(true);
  });

  it('truncates long args in the prompt preview', async () => {
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
    // The prompt contains args but not all 500 chars (truncated to ~120).
    expect(promptText).toMatch(/write_file\(/);
    expect(promptText).toMatch(/\.\.\./);
    expect(promptText.length).toBeLessThan(huge.length + 500);
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

// Coverage note: the end-to-end "stdin-pipe non-TTY refuses write" test
// lives in the unit-level test above; writing it through evaluatePermission
// would re-test the evaluatePermission branching rather than the handler.
it.skip('placeholder for future end-to-end pipe test via runAgentLoop', () => {});
