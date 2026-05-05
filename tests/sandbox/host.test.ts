import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createHostSandbox } from '../../src/sandbox/connectors/host.js';
import { runSandboxApiContract } from './contract.js';

runSandboxApiContract('host', async () => {
  // The contract's scratch path is `/tmp/...` which is on a real fs;
  // the host connector is a passthrough, so we just hand it back
  // unmodified and let the test own that directory.
  return { sandbox: createHostSandbox() };
});

describe('createHostSandbox specifics', () => {
  it('honours the cwd option for exec()', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agent-do-host-'));
    try {
      const sandbox = createHostSandbox({ cwd: dir });
      const r = await sandbox.exec('pwd');
      expect(r.exitCode).toBe(0);
      // realpath dance — macOS /tmp is symlinked to /private/tmp
      expect(r.stdout.trim()).toMatch(new RegExp(path.basename(dir) + '$'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('captures stdout and stderr separately', async () => {
    const sandbox = createHostSandbox();
    const r = await sandbox.exec('echo to-out; echo to-err 1>&2');
    expect(r.stdout.trim()).toBe('to-out');
    expect(r.stderr.trim()).toBe('to-err');
    expect(r.exitCode).toBe(0);
  });

  it('does not throw on a non-zero exit; returns the exit code', async () => {
    const sandbox = createHostSandbox();
    const r = await sandbox.exec('exit 7');
    expect(r.exitCode).toBe(7);
  });

  it('readFileBuffer returns a fresh copy independent of Node Buffer pool', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agent-do-host-'));
    try {
      const sandbox = createHostSandbox();
      const target = path.join(dir, 'b.dat');
      await sandbox.writeFile(target, new Uint8Array([1, 2, 3, 4]));
      const a = await sandbox.readFileBuffer(target);
      const b = await sandbox.readFileBuffer(target);
      // Mutating one read shouldn't affect the other.
      a[0] = 99;
      expect(b[0]).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stat() reports isSymbolicLink correctly (lstat semantics)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agent-do-host-'));
    try {
      const sandbox = createHostSandbox();
      const target = path.join(dir, 'real.txt');
      const link = path.join(dir, 'link');
      await writeFile(target, 'hi');
      await symlink(target, link);
      const linkStat = await sandbox.stat(link);
      expect(linkStat.isSymbolicLink).toBe(true);
      // lstat: isFile is false for the symlink itself (the target IS
      // a file, but stat() should describe the path, not its target).
      expect(linkStat.isFile).toBe(false);

      const realStat = await sandbox.stat(target);
      expect(realStat.isSymbolicLink).toBe(false);
      expect(realStat.isFile).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('realpath() resolves symlinks to their canonical target', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agent-do-host-'));
    try {
      const sandbox = createHostSandbox();
      const target = path.join(dir, 'real');
      const link = path.join(dir, 'link');
      await mkdir(target);
      await symlink(target, link);
      const canonical = await sandbox.realpath!(link);
      // realpath itself canonicalises /tmp on macOS to /private/tmp,
      // so compare against the same canonicalisation of `target`.
      const expected = await sandbox.realpath!(target);
      expect(canonical).toBe(expected);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
