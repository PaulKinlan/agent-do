import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createNoopSandbox } from '../../src/sandbox/connectors/noop.js';
import { runSandboxApiContract } from './contract.js';

runSandboxApiContract('noop', async () => {
  // The contract's scratch path is `/tmp/...` which is on a real fs;
  // noop is a host-fs passthrough, so we just hand it back unmodified
  // and let the test own that directory.
  return { sandbox: createNoopSandbox() };
});

describe('createNoopSandbox specifics', () => {
  it('honours the cwd option for exec()', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agent-do-noop-'));
    try {
      const sandbox = createNoopSandbox({ cwd: dir });
      const r = await sandbox.exec('pwd');
      expect(r.exitCode).toBe(0);
      // realpath dance — macOS /tmp is symlinked to /private/tmp
      expect(r.stdout.trim()).toMatch(new RegExp(path.basename(dir) + '$'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('captures stdout and stderr separately', async () => {
    const sandbox = createNoopSandbox();
    const r = await sandbox.exec('echo to-out; echo to-err 1>&2');
    expect(r.stdout.trim()).toBe('to-out');
    expect(r.stderr.trim()).toBe('to-err');
    expect(r.exitCode).toBe(0);
  });

  it('does not throw on a non-zero exit; returns the exit code', async () => {
    const sandbox = createNoopSandbox();
    const r = await sandbox.exec('exit 7');
    expect(r.exitCode).toBe(7);
  });
});
