/**
 * just-bash connector — wraps a vercel-labs/just-bash `Sandbox` instance
 * (https://github.com/vercel-labs/just-bash) into a {@link SandboxApi}.
 *
 * just-bash is a TypeScript bash interpreter with an in-memory virtual
 * filesystem. exec() runs entirely in-process — no host shell, no host
 * filesystem. Useful for agents that need shell-shaped tooling without
 * the privileges that come with `child_process`.
 *
 * Network policy: just-bash intercepts `fetch`/`curl` inside its
 * interpreter. Pass `allowNet` to gate which hosts the sandbox can reach
 * (the connector forwards it to the underlying Sandbox config when
 * supported).
 *
 * Two construction styles are supported:
 *
 *   // 1. Caller constructs the Sandbox and hands it in (no agent-do
 *   //    dependency on just-bash).
 *   import { Sandbox } from 'just-bash';
 *   const jb = await Sandbox.create({ files });
 *   const sandbox = wrapJustBashSandbox(jb);
 *
 *   // 2. Convenience factory — dynamically imports `just-bash`. Throws
 *   //    a clear error if the package isn't installed.
 *   const sandbox = await createJustBashSandbox({ files, allowNet });
 *
 * Style (1) is the principal API; (2) is a thin wrapper.
 */

import type {
  SandboxApi,
  FileStat,
  ExecOptions,
  ExecResult,
} from '../types.js';

/**
 * Duck-typed shape of just-bash's `Sandbox` class — only the methods we
 * actually call. Keeping this narrow means we don't need a `just-bash`
 * type dependency at compile time, and it documents the integration
 * surface explicitly.
 */
export interface JustBashSandboxLike {
  /** Read a file from the virtual FS. */
  readFile(path: string): Promise<string | Uint8Array>;
  /** Write a map of files into the virtual FS. */
  writeFiles(files: Record<string, string | Uint8Array>): Promise<void>;
  /** Create a directory. */
  mkDir(path: string, options?: { recursive?: boolean }): Promise<void>;
  /**
   * Run a shell command. just-bash returns a "command handle" with
   * `stdout()` (resolves to the buffered stdout) and `wait()` (resolves
   * to the exit metadata). We treat both as optional and fall back to a
   * direct `exec` shape if the instance exposes one.
   */
  runCommand?(
    command: string,
    options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
  ): Promise<JustBashCommandHandle>;
  exec?(
    command: string,
    options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

interface JustBashCommandHandle {
  stdout?(): Promise<string>;
  stderr?(): Promise<string>;
  wait(): Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
}

export interface CreateJustBashSandboxOptions {
  /** Initial files to seed the virtual FS. */
  files?: Record<string, string>;
  /**
   * Network egress policy. just-bash gates network primitives at the
   * interpreter level — the array (or `false`) is forwarded verbatim to
   * the underlying Sandbox config. Connectors should default to
   * `false` (no network) for safety.
   */
  allowNet?: string[] | false;
}

/**
 * Wrap an existing just-bash `Sandbox` instance. This is the principal
 * entry point — all of the contract methods route through `runCommand`
 * (or `exec`, if present) plus the three native fs methods.
 */
export function wrapJustBashSandbox(jb: JustBashSandboxLike): SandboxApi {
  async function runShell(
    command: string,
    options?: ExecOptions,
  ): Promise<ExecResult> {
    if (typeof jb.exec === 'function') {
      const r = await jb.exec(command, options);
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
    }
    if (typeof jb.runCommand !== 'function') {
      throw new Error(
        'just-bash connector: instance exposes neither exec() nor runCommand()',
      );
    }
    const handle = await jb.runCommand(command, options);
    const final = await handle.wait();
    const stdout =
      final.stdout ?? (handle.stdout ? await handle.stdout() : '');
    const stderr =
      final.stderr ?? (handle.stderr ? await handle.stderr() : '');
    return { stdout, stderr, exitCode: final.exitCode };
  }

  return {
    async readFile(path) {
      const content = await jb.readFile(path);
      return typeof content === 'string'
        ? content
        : new TextDecoder('utf-8').decode(content);
    },
    async readFileBuffer(path) {
      const content = await jb.readFile(path);
      return typeof content === 'string'
        ? new TextEncoder().encode(content)
        : content;
    },
    async writeFile(path, content) {
      await jb.writeFiles({ [path]: content });
    },
    async stat(path): Promise<FileStat> {
      // just-bash's Sandbox doesn't expose stat. Drive it through the
      // shell's `[ -f / -d ]` tests + `wc -c` — slow but contractually
      // correct. Connectors are free to override by wrapping their own
      // adapter; this is the portable fallback.
      const isFile = (await runShell(`[ -f ${shellQuote(path)} ]`)).exitCode === 0;
      const isDirectory = (await runShell(`[ -d ${shellQuote(path)} ]`)).exitCode === 0;
      const isSymbolicLink = (await runShell(`[ -L ${shellQuote(path)} ]`)).exitCode === 0;
      let size = 0;
      if (isFile) {
        const sizeRes = await runShell(`wc -c < ${shellQuote(path)}`);
        size = Number.parseInt(sizeRes.stdout.trim(), 10) || 0;
      }
      return { isFile, isDirectory, isSymbolicLink, size, mtime: new Date() };
    },
    async readdir(path) {
      const r = await runShell(`ls -1A ${shellQuote(path)}`);
      if (r.exitCode !== 0) throw new Error(`readdir failed: ${r.stderr.trim()}`);
      return r.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    },
    async exists(path) {
      const r = await runShell(`[ -e ${shellQuote(path)} ]`);
      return r.exitCode === 0;
    },
    async mkdir(path, opts) {
      await jb.mkDir(path, { recursive: opts?.recursive ?? false });
    },
    async rm(path, opts) {
      const flags = [
        opts?.recursive ? 'r' : '',
        opts?.force ? 'f' : '',
      ].join('');
      const flagArg = flags ? `-${flags}` : '';
      const r = await runShell(`rm ${flagArg} ${shellQuote(path)}`);
      if (r.exitCode !== 0 && !opts?.force) {
        throw new Error(`rm failed: ${r.stderr.trim()}`);
      }
    },
    exec: runShell,
  };
}

/**
 * Convenience factory — dynamically imports `just-bash` and constructs a
 * `Sandbox` for you. Throws a friendly error if the package isn't
 * installed (it's an optional peer dep).
 */
export async function createJustBashSandbox(
  options: CreateJustBashSandboxOptions = {},
): Promise<SandboxApi> {
  let mod: { Sandbox?: { create: (opts: unknown) => Promise<JustBashSandboxLike> } };
  try {
    // `just-bash` is an optional peer dep; the dynamic import is the
    // whole point. The package may not be installed at compile time.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — optional peer dep, may not be present at compile time
    mod = (await import('just-bash')) as typeof mod;
  } catch (err) {
    throw new Error(
      "just-bash is not installed. Run `npm install just-bash` and retry, " +
        "or construct a Sandbox yourself and pass it to wrapJustBashSandbox(). " +
        `Underlying error: ${(err as Error).message}`,
    );
  }
  if (!mod.Sandbox?.create) {
    throw new Error(
      'just-bash module loaded but does not export a Sandbox class. ' +
        'Check the package version — agent-do expects the @vercel/sandbox-compatible API.',
    );
  }
  const jb = await mod.Sandbox.create({
    files: options.files,
    allowNet: options.allowNet ?? false,
  });
  return wrapJustBashSandbox(jb);
}

/**
 * Single-arg POSIX shell quoting. Wraps the value in single quotes and
 * escapes any embedded single quote as `'\''`. Sufficient for the
 * narrow use here (paths, not free-form user content).
 */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
