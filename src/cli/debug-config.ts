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
    // Explicit channel map instead of `all: true` — we want the
    // cheap debug channels on, but NOT `response` (that intercepts
    // every raw stream part via the middleware's TransformStream and
    // adds per-token overhead even if the renderer filters it out).
    // (#73 Copilot)
    return {
      systemPrompt: true,
      messages: true,
      request: true,
      cache: true,
      response: false,
      traceResponseParts: false,
    };
  }
  if (args.logLevel === 'trace') {
    // Trace pays the per-token cost in exchange for seeing every
    // stream part. Deliberate — the operator asked for the firehose.
    return {
      systemPrompt: true,
      messages: true,
      request: true,
      cache: true,
      response: true,
      traceResponseParts: true,
    };
  }
  return undefined;
}
