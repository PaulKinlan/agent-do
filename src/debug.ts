/**
 * The debug surface for a run (#72): installing the debug middleware and emitting
 * the system-prompt and cache events.
 *
 * Split out of `src/loop.ts` (agent-do-4os). The middleware itself lives in
 * `debug-middleware.ts`; this module is the wiring the loop uses.
 */

import { wrapLanguageModel, type LanguageModel } from 'ai';
import type { AgentConfig, DebugConfig, DebugEvent, ProgressEvent } from './types.js';
import {
  createDebugMiddleware,
  clampString,
  extractCacheUsage,
  type StepRef,
} from './debug-middleware.js';

/**
 * Build the debug surface for a run (#72). Returns:
 *
 * - `model`: the original model, or a `wrapLanguageModel`-wrapped copy
 *   with the debug middleware installed when `debug` is set.
 * - `emit`: the unified emitter. Fans out to `progressEvents` (so
 *   stream consumers see `type: 'debug'` events) and to the caller's
 *   `sink` if one was provided.
 * - `stepRef`: mutable step counter the loop updates before each
 *   `streamText` call so the middleware can tag events with the
 *   correct outer iteration.
 *
 * Returns `{ model: original, emit: noop, stepRef }` when `debug` is
 * undefined so the default path has zero overhead.
 */
export function setupDebug(
  config: AgentConfig,
  onProgress?: (event: ProgressEvent) => void,
): {
  model: LanguageModel;
  emit: (event: DebugEvent) => void;
  stepRef: StepRef;
} {
  const debug = config.debug;
  const stepRef: StepRef = { current: 0 };
  if (!debug) {
    return { model: config.model, emit: () => {}, stepRef };
  }

  const emit = (event: DebugEvent): void => {
    if (onProgress) {
      onProgress({
        type: 'debug',
        content: `[debug:${event.channel}] step=${event.step}`,
        debug: event,
        step: event.step,
      });
    }
    if (debug.sink) {
      // Best-effort: swallow sink errors so a broken debug hook can't
      // wedge the main loop. Debug is observational — the run still
      // has to complete cleanly.
      try {
        const result = debug.sink(event);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch(() => { /* sink errors are non-fatal */ });
        }
      } catch { /* sink errors are non-fatal */ }
    }
  };

  // `wrapLanguageModel` expects a structured LanguageModelV3 value,
  // not a string model id. When the caller passed a string id (and
  // the AI SDK will resolve it to a provider at stream time), we
  // can't install middleware — the string wraps a lazy resolution
  // we don't control. Fall back to the unwrapped model in that
  // case; the other debug channels that don't depend on middleware
  // (system-prompt, cache via onStepEnd) still fire.
  if (typeof config.model === 'string') {
    return { model: config.model, emit, stepRef };
  }
  const model = wrapLanguageModel({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model: config.model as any,
    middleware: createDebugMiddleware(debug, emit, stepRef),
  }) as LanguageModel;

  return { model, emit, stepRef };
}

/**
 * Emit the one-shot system-prompt debug event. Fires before the first
 * model call so the operator can see the exact resolved prompt that
 * will ride through every iteration's cache breakpoint.
 */
export function emitSystemPromptDebug(
  debug: DebugConfig | undefined,
  emit: (event: DebugEvent) => void,
  systemPrompt: string,
): void {
  if (!debug || !(debug.all || debug.systemPrompt)) return;
  const maxBytes = debug.maxBodyBytes ?? 16 * 1024;
  const { content, bytes, truncated } = clampString(systemPrompt, maxBytes);
  emit({ channel: 'system-prompt', step: 0, content, bytes, truncated });
}

/**
 * Emit a per-step cache debug event. Called from the existing
 * `buildOnStepEnd` hook so cache metrics land adjacent to usage
 * recording and can be correlated with cost.
 */
export function emitCacheDebug(
  debug: DebugConfig | undefined,
  emit: (event: DebugEvent) => void,
  step: number,
  stepPayload: unknown,
): void {
  if (!debug || !(debug.all || debug.cache)) return;
  const usage = (stepPayload as { usage?: unknown } | undefined)?.usage;
  const providerMetadata = (stepPayload as { providerMetadata?: Record<string, unknown> } | undefined)
    ?.providerMetadata;
  const breakdown = extractCacheUsage(usage);
  emit({
    channel: 'cache',
    step,
    ...breakdown,
    providerMetadata,
  });
}
