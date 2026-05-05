/**
 * Noop sandbox — host passthrough.
 *
 * **Not a security boundary.** Reads and writes go straight to
 * `node:fs/promises`, exec spawns a real shell. Useful for:
 *
 * - Tests (the contract suite runs against this implementation).
 * - Explicit opt-out — when a caller wants the SandboxApi *shape*
 *   (e.g. for a `bash` tool) without isolation.
 *
 * For real isolation, use one of the other connectors.
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

export interface NoopSandboxOptions {
  /**
   * Default `cwd` applied to `exec()` calls that don't supply their own.
   * Falls back to `process.cwd()` when omitted.
   */
  cwd?: string;
}

export function createNoopSandbox(options: NoopSandboxOptions = {}): SandboxApi {
  const defaultCwd = options.cwd;

  return {
    async readFile(path) {
      return await fsp.readFile(path, 'utf-8');
    },
    async readFileBuffer(path) {
      const buf = await fsp.readFile(path);
      // Return a Uint8Array view; the underlying Buffer is already
      // a Uint8Array on Node, but typing demands the explicit copy
      // so consumers can't accidentally treat it as a Buffer.
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
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
