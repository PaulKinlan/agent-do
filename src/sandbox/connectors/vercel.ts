/**
 * Vercel Sandbox connector — stub.
 *
 * `@vercel/sandbox` boots a Firecracker microVM and exposes an SDK with
 * `runCommand`, `readFile`, `writeFile`, `mkDir`, etc. The connector is
 * a thin adapter: every {@link SandboxApi} method delegates to the SDK,
 * with `stat` / `exists` / `readdir` falling back through `runCommand`
 * if the SDK doesn't expose them directly.
 *
 * Network policy on Vercel is configured on the `Sandbox` instance the
 * caller supplies; agent-do doesn't second-guess it.
 *
 * See https://vercel.com/docs/workflow-collaboration/sandbox.
 *
 * This file documents the integration shape; the implementation lands
 * in a follow-up PR alongside the optional peer dep on `@vercel/sandbox`.
 */

import type { SandboxApi } from '../types.js';

export interface VercelSandboxLike {
  runCommand(cmd: string, opts?: { cwd?: string; env?: Record<string, string> }): Promise<{
    stdout(): Promise<string>;
    stderr(): Promise<string>;
    wait(): Promise<{ exitCode: number }>;
  }>;
  readFile(path: string): Promise<string>;
  writeFiles(files: Record<string, string>): Promise<void>;
  mkDir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  stop?(): Promise<void>;
}

export interface CreateVercelSandboxOptions {
  /** Pre-created `@vercel/sandbox` instance. */
  sandbox: VercelSandboxLike;
}

export function createVercelSandbox(_options: CreateVercelSandboxOptions): SandboxApi {
  throw new Error(
    'createVercelSandbox is not yet implemented. Track #3 follow-up; the connector ' +
      'shape mirrors createJustBashSandbox — use that as a template if you want to ' +
      'land the implementation early.',
  );
}
