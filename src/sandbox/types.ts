/**
 * SandboxApi — pluggable sandbox contract for tool I/O.
 *
 * Ported from the Astro Flue sandbox-connector spec
 * (https://github.com/withastro/flue/blob/main/docs/sandbox-connector-spec.md).
 *
 * The contract is the lowest-common-denominator across local interpreters
 * (just-bash), OS-level filters (sandbox-runtime, seatbelt, bubblewrap),
 * and remote VM platforms (Vercel Sandbox, Deno Sandbox, E2B). All paths
 * are connector-relative; an absolute path's meaning is the connector's
 * choice (host fs vs virtual fs vs remote VM root).
 *
 * Connectors that lack a primitive should fall back to `exec()` — e.g.
 * `mkdir(p, { recursive: true })` becomes `exec('mkdir -p ...')`.
 *
 * Network policy is intentionally *not* on this contract. Each connector
 * accepts its own network shape at construction time (see
 * `docs/sandbox.md`). A future `SandboxApiWithFetch` interface can extend
 * this one when proxy-level fetch becomes a shared capability.
 */

export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mtime: Date;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Wall-clock timeout in milliseconds. Connectors may approximate. */
  timeout?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxApi {
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<FileStat>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
}
