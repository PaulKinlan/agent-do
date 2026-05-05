/**
 * Deno Sandbox connector — stub.
 *
 * Deno's hosted Sandbox exposes an SDK with microVM-backed isolation,
 * domain-level egress allowlisting (`allowNet`), and persistent volumes.
 * The connector is a thin adapter to that SDK.
 *
 * Network policy: Deno's sandbox enforces `allowNet` natively. Pass the
 * domain list through; the connector forwards it verbatim.
 *
 * See https://docs.deno.com/sandbox/.
 *
 * This file documents the integration shape; the implementation lands
 * in a follow-up PR alongside the optional peer dep.
 */

import type { SandboxApi } from '../types.js';

export interface CreateDenoSandboxOptions {
  /** Domain-level egress allowlist forwarded to Deno's --allow-net. */
  allowNet?: string[];
  /** Persistent volume identifier (300MB-20GB). Maps to Deno's volume API. */
  volume?: string;
}

export function createDenoSandbox(_options: CreateDenoSandboxOptions = {}): Promise<SandboxApi> {
  throw new Error(
    'createDenoSandbox is not yet implemented. Track #3 follow-up.',
  );
}
