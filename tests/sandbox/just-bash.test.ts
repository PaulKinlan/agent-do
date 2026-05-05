import { describe, it, expect } from 'vitest';
import { wrapJustBashSandbox } from '../../src/sandbox/connectors/just-bash.js';
import type { JustBashSandboxLike } from '../../src/sandbox/connectors/just-bash.js';

/**
 * just-bash is an optional peer dep. We don't import it here — instead
 * we hand `wrapJustBashSandbox` a duck-typed double that captures the
 * exec calls. That gives us deterministic coverage of the adapter's
 * routing logic (string-to-shell, exit-code propagation, fallback to
 * `runCommand` when `exec` is absent) without pulling the real package
 * into the test runtime.
 *
 * Live integration with the real `just-bash` package belongs in a
 * follow-up gated on env flags.
 */

interface ExecCall { command: string; opts: unknown }

function fakeJustBash(): { sandbox: JustBashSandboxLike; calls: ExecCall[] } {
  const fs = new Map<string, string | Uint8Array>();
  const calls: ExecCall[] = [];

  const sandbox: JustBashSandboxLike = {
    async readFile(path) {
      const v = fs.get(path);
      if (v === undefined) throw new Error(`ENOENT ${path}`);
      return v;
    },
    async writeFiles(files) {
      for (const [k, v] of Object.entries(files)) fs.set(k, v);
    },
    async mkDir(_path) {
      // virtual fs — no-op for the fake. The connector's mkdir routes
      // here directly, so we just record the intent by writing a sentinel.
    },
    async exec(command, opts) {
      calls.push({ command, opts });
      // Minimal command emulation just for the contract probes that
      // route through `exec`: ls / [ -e ] / [ -f ] / [ -d ] / wc -c / rm.
      if (command === 'echo hello') {
        return { stdout: 'hello\n', stderr: '', exitCode: 0 };
      }
      if (command === 'false') {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      const m = command.match(/^\[ -([efdLs]) '(.+)' \]$/);
      if (m) {
        const [, flag, p] = m;
        const present = fs.has(p!);
        if (flag === 'e') return { stdout: '', stderr: '', exitCode: present ? 0 : 1 };
        if (flag === 'f') return { stdout: '', stderr: '', exitCode: present ? 0 : 1 };
        if (flag === 'd') return { stdout: '', stderr: '', exitCode: 0 };
        if (flag === 'L') return { stdout: '', stderr: '', exitCode: 1 };
      }
      const lsMatch = command.match(/^ls -1A '(.+)'$/);
      if (lsMatch) {
        const dir = lsMatch[1]!;
        const prefix = dir.endsWith('/') ? dir : `${dir}/`;
        const entries = [...fs.keys()]
          .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
          .map((k) => k.slice(prefix.length));
        return { stdout: entries.join('\n') + '\n', stderr: '', exitCode: 0 };
      }
      const wcMatch = command.match(/^wc -c < '(.+)'$/);
      if (wcMatch) {
        const v = fs.get(wcMatch[1]!);
        const n = typeof v === 'string' ? Buffer.byteLength(v, 'utf-8') : (v?.byteLength ?? 0);
        return { stdout: `${n}\n`, stderr: '', exitCode: 0 };
      }
      const rmMatch = command.match(/^rm (-[rf]+ )?'(.+)'$/);
      if (rmMatch) {
        const target = rmMatch[2]!;
        const had = fs.delete(target);
        return { stdout: '', stderr: had ? '' : 'no such file', exitCode: had ? 0 : 1 };
      }
      return { stdout: '', stderr: `unhandled: ${command}`, exitCode: 1 };
    },
  };
  return { sandbox, calls };
}

describe('wrapJustBashSandbox', () => {
  it('round-trips read/write', async () => {
    const { sandbox } = fakeJustBash();
    const api = wrapJustBashSandbox(sandbox);
    await api.writeFile('/x.txt', 'hi');
    expect(await api.readFile('/x.txt')).toBe('hi');
  });

  it('exists() returns true after write, false after rm', async () => {
    const { sandbox } = fakeJustBash();
    const api = wrapJustBashSandbox(sandbox);
    await api.writeFile('/x.txt', 'hi');
    expect(await api.exists('/x.txt')).toBe(true);
    await api.rm('/x.txt', { force: true });
    expect(await api.exists('/x.txt')).toBe(false);
  });

  it('exec passes through to the underlying instance', async () => {
    const { sandbox, calls } = fakeJustBash();
    const api = wrapJustBashSandbox(sandbox);
    const r = await api.exec('echo hello', { cwd: '/work' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('hello\n');
    expect(calls.find((c) => c.command === 'echo hello')).toBeTruthy();
  });

  it('falls back to runCommand when exec is absent', async () => {
    const recorded: string[] = [];
    const sandbox: JustBashSandboxLike = {
      async readFile() {
        return '';
      },
      async writeFiles() {},
      async mkDir() {},
      async runCommand(cmd) {
        recorded.push(cmd);
        return {
          async stdout() { return 'from-runCommand'; },
          async stderr() { return ''; },
          async wait() { return { exitCode: 0 }; },
        };
      },
    };
    const api = wrapJustBashSandbox(sandbox);
    const r = await api.exec('whatever');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('from-runCommand');
    expect(recorded).toEqual(['whatever']);
  });

  it('rm with force still propagates non-not-found failures', async () => {
    const sandbox: JustBashSandboxLike = {
      async readFile() { return ''; },
      async writeFiles() {},
      async mkDir() {},
      async exec() {
        return { stdout: '', stderr: 'permission denied', exitCode: 1 };
      },
    };
    const api = wrapJustBashSandbox(sandbox);
    await expect(api.rm('/protected', { force: true })).rejects.toThrow(
      /rm failed/,
    );
  });

  it('rm with force swallows not-found errors (POSIX rm -f semantics)', async () => {
    const sandbox: JustBashSandboxLike = {
      async readFile() { return ''; },
      async writeFiles() {},
      async mkDir() {},
      async exec() {
        return { stdout: '', stderr: 'no such file or directory', exitCode: 1 };
      },
    };
    const api = wrapJustBashSandbox(sandbox);
    await expect(api.rm('/missing', { force: true })).resolves.toBeUndefined();
  });

  it('throws when the instance exposes neither exec nor runCommand', async () => {
    const sandbox = {
      async readFile() { return ''; },
      async writeFiles() {},
      async mkDir() {},
    } as unknown as JustBashSandboxLike;
    const api = wrapJustBashSandbox(sandbox);
    await expect(api.exec('echo hi')).rejects.toThrow(/exec\(\) nor runCommand\(\)/);
  });
});
