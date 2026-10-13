import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createHostSandbox, pickExecEnv } from '../../src/sandbox/connectors/host.js';
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

/**
 * Read a variable as the child shell sees it, via a builtin expansion
 * that doesn't depend on `PATH` (otherwise a test for "PATH is
 * forwarded" would be circular).
 */
function printVar(name: string): string {
  return `printf '%s' "\${${name}-unset}"`;
}

async function readVar(sandbox: ReturnType<typeof createHostSandbox>, name: string) {
  const r = await sandbox.exec(printVar(name));
  expect(r.exitCode).toBe(0);
  return r.stdout.trim();
}

/** Set parent env vars for the duration of `fn`, then restore them. */
async function withParentEnv(
  vars: Record<string, string>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(vars)) {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe('pickExecEnv (default allowlist)', () => {
  // Fictional names throughout: this describes the default only, so it
  // must not depend on — or leak — the test runner's real environment.
  const parent: Record<string, string | undefined> = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/tester',
    LANG: 'en_GB.UTF-8',
    LC_CTYPE: 'UTF-8',
    TZ: 'UTC',
    TERM: 'xterm-256color',
    NODE_ENV: 'test',
    ANTHROPIC_API_KEY: 'sk-ant-not-a-real-key',
    OPENAI_API_KEY: 'sk-not-a-real-key',
    AWS_SECRET_ACCESS_KEY: 'not-a-real-aws-key',
    GITHUB_TOKEN: 'ghp_not_a_real_token',
    HTTPS_PROXY: 'http://user:password@proxy.example',
    NODE_OPTIONS: '--require ./not-a-real-file.js',
    LD_PRELOAD: '/tmp/not-a-real-lib.so',
    SSH_AUTH_SOCK: '/tmp/not-a-real-agent.sock',
    GIT_AUTHOR_NAME: 'Tester',
    UNDEFINED_ONE: undefined,
  };

  it('forwards the useful non-secret names', () => {
    const env = pickExecEnv(parent);
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/home/tester');
    expect(env.LANG).toBe('en_GB.UTF-8');
    expect(env.LC_CTYPE).toBe('UTF-8'); // prefix allowlist
    expect(env.TZ).toBe('UTC');
    expect(env.TERM).toBe('xterm-256color');
    expect(env.NODE_ENV).toBe('test');
  });

  it('drops credentials, code-injection hooks and unlisted names', () => {
    const env = pickExecEnv(parent);
    for (const name of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'GITHUB_TOKEN',
      'HTTPS_PROXY',
      'NODE_OPTIONS',
      'LD_PRELOAD',
      'SSH_AUTH_SOCK',
      'GIT_AUTHOR_NAME',
      'UNDEFINED_ONE',
    ]) {
      expect(env).not.toHaveProperty(name);
    }
  });

  it('adds extra names as exact matches, not patterns', () => {
    const env = pickExecEnv(parent, ['GIT_AUTHOR_NAME', 'AWS_']);
    expect(env.GIT_AUTHOR_NAME).toBe('Tester');
    // An extra entry is a name, so the prefix form matches nothing.
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
  });
});

describe('createHostSandbox environment policy', () => {
  it('forwards an allowlisted var but not an arbitrary parent var', async () => {
    await withParentEnv(
      { AGENT_DO_LEAK_PROBE: 'provider-key-material' },
      async () => {
        const sandbox = createHostSandbox();
        expect(await readVar(sandbox, 'PATH')).not.toBe('unset');
        expect(await readVar(sandbox, 'AGENT_DO_LEAK_PROBE')).toBe('unset');
      },
    );
  });

  it('forwards names listed in envPassthrough', async () => {
    await withParentEnv(
      { AGENT_DO_PASSTHROUGH_PROBE: 'opted-in-value' },
      async () => {
        const sandbox = createHostSandbox({
          envPassthrough: ['AGENT_DO_PASSTHROUGH_PROBE'],
        });
        expect(await readVar(sandbox, 'AGENT_DO_PASSTHROUGH_PROBE')).toBe(
          'opted-in-value',
        );
      },
    );
  });

  it('forwards the whole parent env under inheritEnv: true', async () => {
    await withParentEnv(
      { AGENT_DO_INHERIT_PROBE: 'inherited-value' },
      async () => {
        const sandbox = createHostSandbox({ inheritEnv: true });
        expect(await readVar(sandbox, 'AGENT_DO_INHERIT_PROBE')).toBe(
          'inherited-value',
        );
      },
    );
  });

  it('applies opts.env on top of the default and lets it win', async () => {
    const sandbox = createHostSandbox();
    const r = await sandbox.exec(printVar('AGENT_DO_CALL_ENV'), {
      env: { AGENT_DO_CALL_ENV: 'per-call' },
    });
    expect(r.stdout.trim()).toBe('per-call');
  });
});
