/**
 * Host sandbox — direct passthrough to the host system.
 *
 * Implements {@link SandboxApi} by talking to `node:fs/promises` and
 * `node:child_process` directly. **Not a security boundary** — agents
 * can read, write, and execute anywhere the Node.js process can. Use
 * it when:
 *
 * - You want the `SandboxApi` *shape* (e.g. so tools like
 *   `createBashTool` work) without adding isolation.
 * - You're running tests and want to exercise the contract against
 *   real fs / child_process behaviour.
 * - You're shipping to an environment that already provides isolation
 *   at a higher layer (Docker, Firecracker microVM, gVisor, Deno
 *   Sandbox, Vercel Sandbox) and just need the API surface.
 *
 * For real in-process isolation, use {@link createJustBashSandbox}.
 */

import * as fsp from 'node:fs/promises';
import { exec as cpExec } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  SandboxApi,
  FileStat,
  ExecOptions,
  ExecResult,
} from '../types.js';

const execAsync = promisify(cpExec);

export interface HostSandboxOptions {
  /**
   * Default `cwd` applied to `exec()` calls that don't supply their own.
   * Falls back to `process.cwd()` when omitted.
   */
  cwd?: string;
}

export function createHostSandbox(options: HostSandboxOptions = {}): SandboxApi {
  const defaultCwd = options.cwd;

  return {
    async readFile(path) {
      return await fsp.readFile(path, 'utf-8');
    },
    async readFileBuffer(path) {
      const buf = await fsp.readFile(path);
      // Copy into a fresh Uint8Array so callers can't accidentally
      // mutate Node's internal pool-backed Buffer. The
      // `new Uint8Array(buf)` ctor copies; the three-arg form would
      // alias.
      return new Uint8Array(buf);
    },
    async writeFile(path, content) {
      if (typeof content === 'string') {
        await fsp.writeFile(path, content, 'utf-8');
      } else {
        await fsp.writeFile(path, content);
      }
    },
    async stat(path): Promise<FileStat> {
      const s = await fsp.stat(path);
      return {
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        isSymbolicLink: s.isSymbolicLink(),
        size: s.size,
        mtime: s.mtime,
      };
    },
    async readdir(path) {
      return await fsp.readdir(path);
    },
    async exists(path) {
      try {
        await fsp.stat(path);
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return false;
        throw err;
      }
    },
    async mkdir(path, opts) {
      await fsp.mkdir(path, { recursive: opts?.recursive ?? false });
    },
    async rm(path, opts) {
      await fsp.rm(path, {
        recursive: opts?.recursive ?? false,
        force: opts?.force ?? false,
      });
    },
    async exec(command, opts: ExecOptions = {}): Promise<ExecResult> {
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: opts.cwd ?? defaultCwd,
          env: opts.env ? { ...process.env, ...opts.env } : process.env,
          timeout: opts.timeout,
        });
        return { stdout: String(stdout), stderr: String(stderr), exitCode: 0 };
      } catch (err) {
        // node's exec rejects on non-zero exit; surface stdout/stderr
        // and the actual exit code instead of throwing.
        const e = err as NodeJS.ErrnoException & {
          stdout?: string | Buffer;
          stderr?: string | Buffer;
          code?: number | string;
          killed?: boolean;
          signal?: string;
        };
        const exitCode =
          typeof e.code === 'number'
            ? e.code
            : e.killed
              ? 124 // conventional timeout exit
              : 1;
        return {
          stdout: e.stdout ? String(e.stdout) : '',
          stderr: e.stderr ? String(e.stderr) : String(e.message ?? ''),
          exitCode,
        };
      }
    },
  };
}
