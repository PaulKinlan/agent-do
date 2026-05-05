/**
 * `@anthropic-ai/sandbox-runtime` connector — stub.
 *
 * sandbox-runtime is a research-preview library from Anthropic that
 * enforces filesystem and network restrictions at the OS level
 * (sandbox-exec on macOS, bubblewrap + network namespaces on Linux,
 * Windows unsupported). It exposes a `SandboxManager` that wraps a
 * command in OS-level sandboxing primitives.
 *
 * This file documents the integration shape so a follow-up PR can flesh
 * it out. It is intentionally not implemented yet — pulling in
 * sandbox-runtime requires the optional peer dep, OS-specific code
 * paths, and live integration testing that we want to handle separately
 * from the contract landing.
 *
 * Sketch of the implementation:
 *
 *   import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
 *   await SandboxManager.initialize(config);
 *   const wrapped = await SandboxManager.wrapWithSandbox(cmd);
 *   const child = spawn(wrapped, { shell: true });
 *
 * - `exec` would shell out via `SandboxManager.wrapWithSandbox`.
 * - fs methods would use `node:fs/promises` directly but pre-check
 *   paths against `cfg.filesystem.allow*` / `deny*` patterns and refuse
 *   operations outside policy.
 * - `network.allowedDomains` is forwarded to sandbox-runtime's filter.
 *
 * See https://github.com/anthropic-experimental/sandbox-runtime.
 */

import type { SandboxApi } from '../types.js';

export interface SandboxRuntimeOptions {
  network?: {
    allowedDomains?: string[];
    deniedDomains?: string[];
    allowUnixSockets?: string[];
    allowLocalBinding?: boolean;
  };
  filesystem?: {
    allowRead?: string[];
    denyRead?: string[];
    allowWrite?: string[];
    denyWrite?: string[];
  };
}

export function createSandboxRuntimeSandbox(
  _options: SandboxRuntimeOptions = {},
): Promise<SandboxApi> {
  throw new Error(
    'createSandboxRuntimeSandbox is not yet implemented. Track #3 follow-up; ' +
      'in the meantime use createNoopSandbox() for tests or createJustBashSandbox() ' +
      'for in-process isolation.',
  );
}
