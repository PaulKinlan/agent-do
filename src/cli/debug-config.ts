/**
 * Translate CLI log-level flags into an `AgentConfig.debug` config (#72).
 *
 * - `info` / `verbose` / `silent` → no debug surface; existing
 *   progress events cover what the user needs.
 * - `debug` → all channels except `response-part` per-event detail
 *   (the compact summary is fine; full parts are too noisy).
 * - `trace` → all channels *plus* full raw response parts.
 *
 * Splitting this out from `args.ts` keeps the debug wiring out of the
 * core argument parser — it's purely a CLI convenience.
 */

import type { DebugConfig } from '../types.js';
import type { ParsedArgs } from './args.js';

export function buildDebugConfigFromArgs(args: ParsedArgs): DebugConfig | undefined {
  if (args.logLevel === 'debug') {
    return { all: true, traceResponseParts: false };
  }
  if (args.logLevel === 'trace') {
    return { all: true, traceResponseParts: true };
  }
  return undefined;
}
