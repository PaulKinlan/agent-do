/**
 * Core autonomous agent loop.
 *
 * Calls streamText() in a loop, executing tools and continuing
 * until the model responds with text only (no tool calls) or
 * the iteration limit is reached.
 */

import { streamText, stepCountIs, type ModelMessage, type LanguageModel } from 'ai';
import type {
  AgentConfig,
  ConversationMessage,
  ProgressEvent,
  RunResult,
} from './types.js';
import { setupDebug, emitSystemPromptDebug } from './debug.js';
import { buildTools, type ToolResultCache, type ToolCallCounters } from './tools-build.js';
import { buildSystemPrompt } from './system-prompt.js';
import { buildOnStepEnd } from './step-bookkeeping.js';
import { mountConfigMcp } from './mcp.js';
import { tryRouteSlashCommandRun } from './slash-commands.js';

// Re-exported so importers of the loop module (and its tests) keep working unchanged.
export { buildOnStepEnd };
import { addCacheControl } from './cache.js';
import type { ToolResult } from './tools/types.js';

// The Anthropic model-cache helpers live in ./cache.js now (agent-do-4os). `isAnthropicModel` is
// re-exported here so existing importers of the loop module keep working unchanged.
export { isAnthropicModel } from './cache.js';

/**
 * True when a stream part reports a provider-executed (server-side) tool
 * call or result (agent-do-cgh). The provider runs these tools itself —
 * no local `execute` fires — so the loop observes them here.
 */
function isProviderExecuted(part: unknown): boolean {
  return (part as { providerExecuted?: boolean } | undefined)?.providerExecuted === true;
}

/** JSON-stringify that never throws and never returns undefined. */
function safeJsonStringify(v: unknown): string {
  try {
    const json = JSON.stringify(v);
    if (typeof json === 'string') return json;
  } catch { /* fall through */ }
  return String(v);
}

/**
 * Bounded ToolResult for a provider-executed (server-side) tool result
 * (agent-do-dul review P1). The event stream emits `summary` and `data`
 * by default — `emitFullResult` only gates `toolResult` — so neither may
 * carry the payload: `userSummary` is a bounded descriptor, `data` records
 * provenance + size, and the full payload lives only in `modelContent`,
 * which reaches consumers via `emitFullResult` and hooks.
 */
function normaliseProviderToolResult(toolName: string, raw: unknown): ToolResult {
  const payload = safeJsonStringify(raw);
  return {
    modelContent: payload,
    userSummary: `[${toolName}] provider-executed result (${payload.length} bytes)`,
    data: { providerExecuted: true, bytes: payload.length },
  };
}

/**
 * Bounded ToolResult for a provider-executed tool error (agent-do-dul
 * review P2). Server error text is clipped before it reaches the operator
 * stream; the full text stays in `modelContent` for hooks / emitFullResult.
 */
function normaliseProviderToolError(toolName: string, error: unknown): ToolResult {
  const text = typeof error === 'string' ? error : safeJsonStringify(error);
  const clipped = text.length > 200 ? `${text.slice(0, 197)}...` : text;
  return {
    modelContent: `Error: provider-executed tool "${toolName}" failed: ${text}`,
    userSummary: `[${toolName}] PROVIDER ERROR — ${clipped}`,
    data: { providerExecuted: true, error: clipped },
  };
}

/**
 * Post-hoc enforcement of the run-level tool-call limit for
 * provider-executed calls (agent-do-cgh).
 *
 * Provider-side executions cannot be denied pre-invocation, so once the
 * observed total (local + provider) exceeds `maxToolCalls` — and the run
 * actually made provider calls, keeping pure-local runs on the wrapper's
 * per-call denial semantics — no further iterations are scheduled. The
 * provider-side cost of the current step is already spent; this bounds
 * the runaway, it cannot un-spend it.
 */
function providerToolLimitExceeded(
  config: AgentConfig,
  toolCounters: ToolCallCounters,
  providerToolCalls: number,
): boolean {
  return (
    providerToolCalls > 0 &&
    config.toolLimits?.maxToolCalls !== undefined &&
    toolCounters.total > config.toolLimits.maxToolCalls
  );
}

import { UsageTracker } from './usage.js';
import { cutoffForKeepWindow, stripStaleToolOutputs } from './loop-history.js';
import {
  parseSlashCommand,
  unknownSlashCommandMessage,
} from './slash-commands.js';

const DEFAULT_HISTORY_KEEP_WINDOW = 1;


const DEFAULT_MAX_ITERATIONS = 20;
const DEFAULT_INNER_STEP_LIMIT = 5;






/**
 * Run the agent loop and return the final result.
 *
 * If `config.mcpServers` is set, the servers are mounted at the start
 * and closed after the run completes (or errors) so the caller doesn't
 * have to manage their lifecycle manually.
 *
 * Slash-command dispatch (#76) happens first: when the task starts
 * with `/<name>`, the configured sub-agent runs instead of the parent
 * model — deterministically, with zero LLM cost.
 */
export async function runAgentLoop(
  config: AgentConfig,
  task: string,
  context?: string,
  history?: ConversationMessage[],
): Promise<RunResult> {
  // Deterministic slash-command dispatch — before any model call,
  // before MCP mount. Zero LLM cost; routing is structural (#76).
  const routed = await tryRouteSlashCommandRun(config, task, context);
  if (routed) return routed;

  const { config: resolvedConfig, mcp } = await mountConfigMcp(config);
  try {
    return await runAgentLoopDirect(resolvedConfig, task, context, history);
  } finally {
    if (mcp) await mcp.close();
  }
}

/**
 * Direct (non-streaming) implementation of the agent loop.
 */
async function runAgentLoopDirect(
  config: AgentConfig,
  task: string,
  context?: string,
  history?: ConversationMessage[],
): Promise<RunResult> {
  const maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const innerStepLimit = config.innerStepLimit ?? DEFAULT_INNER_STEP_LIMIT;
  const signal = config.signal;
  const resultCache: ToolResultCache = new Map();
  // History hygiene: track where each outer iteration's messages start
  // so we can redact tool-output bodies older than `historyKeepWindow`
  // iterations. See src/loop-history.ts for rationale (#33).
  const iterationStarts: number[] = [];
  const historyKeepWindow =
    config.historyKeepWindow ?? DEFAULT_HISTORY_KEEP_WINDOW;
  // Shared counters for per-run and per-iteration tool-call limits (#27).
  const toolCounters: ToolCallCounters = { total: 0, perIteration: 0 };

  // Usage tracking
  const tracker = new UsageTracker({
    pricing: config.usage?.pricing,
    perRunLimit: config.usage?.limits?.perRun,
    perDayLimit: config.usage?.limits?.perDay,
    onLimitExceeded: config.usage?.onLimitExceeded,
  });

  // Debug surface (#72). No-op when config.debug is undefined.
  // runAgentLoopDirect doesn't have a progress-event stream, so
  // debug events flow only through the caller's sink (if any).
  const debugSurface = setupDebug(config);
  const model = debugSurface.model;

  // Build system prompt
  const systemPrompt = await buildSystemPrompt(config, context);
  emitSystemPromptDebug(config.debug, debugSurface.emit, systemPrompt);

  // Message history — prepend conversation history if provided
  const messages: ModelMessage[] = [];
  if (history) {
    for (const msg of history) {
      messages.push({ role: msg.role, content: msg.content } as ModelMessage);
    }
  }
  messages.push({ role: 'user', content: task });

  let lastText = '';
  let aborted = false;
  // Observed provider-executed (server-side) tool calls for this run
  // (agent-do-cgh). Counted from the stream; never increments from the
  // local wrapper path.
  let providerToolCalls = 0;
  // Outer-iteration counter kept separately from `tracker.records`
  // since PR #65 made the tracker record per *inner* model step.
  // `RunResult.steps` historically meant "how many outer iterations
  // ran", so preserve that contract here.
  let outerIterations = 0;

  for (let i = 0; i < maxIterations; i++) {
    // Check abort
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    outerIterations = i + 1;
    // Middleware needs the current iteration before any request fires.
    debugSurface.stepRef.current = i;

    // Step start hook
    if (config.hooks?.onStepStart) {
      const summary = tracker.getSummary();
      const decision = await config.hooks.onStepStart({
        step: i,
        totalSteps: maxIterations,
        tokensSoFar: summary.totalInputTokens + summary.totalOutputTokens,
        costSoFar: summary.totalCost,
      });
      if (decision?.decision === 'stop') {
        break;
      }
    }

    // Check spending limits (skip first iteration)
    if (i > 0 && config.usage?.enabled !== false) {
      const withinLimits = await tracker.checkLimits();
      if (!withinLimits) {
        break;
      }
    }

    // Redact stale tool outputs before the next streamText call. We do
    // this here (rather than after the previous iteration ended) so
    // that hooks observing intermediate state still see the fresh data.
    stripStaleToolOutputs(
      messages,
      cutoffForKeepWindow(iterationStarts, historyKeepWindow),
    );

    // Mark this iteration's messages-start position so future redaction
    // passes know what counts as "fresh".
    iterationStarts.push(messages.length);

    // Reset per-iteration tool-call counter (#27).
    toolCounters.perIteration = 0;

    // Build tools for this step (so hooks get the current step number)
    const tools = buildTools(config, i, resultCache, toolCounters);

    // Per-step hard spending cap (#31). Aborts streamText mid-iteration
    // when the projected cost would cross the hard cap. A fresh
    // controller per iteration avoids stale aborted-state leaking.
    const stepAbort = new AbortController();
    const parentSignal = signal;
    const onParentAbort = () => stepAbort.abort(parentSignal?.reason);
    if (parentSignal) {
      if (parentSignal.aborted) stepAbort.abort(parentSignal.reason);
      else parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
    const onStepEnd = buildOnStepEnd(
      config,
      tracker,
      stepAbort,
      i,
      debugSurface.emit,
    );

    // Call streamText
    const result = streamText({
      model,
      instructions: systemPrompt,
      messages,
      tools: Object.keys(tools).length > 0 ? tools : undefined,
      stopWhen: stepCountIs(innerStepLimit),
      abortSignal: stepAbort.signal,
      onStepEnd,
      providerOptions: config.providerOptions,
      prepareStep: ({ messages: stepMsgs }) => ({
        messages: addCacheControl(stepMsgs, config.model as LanguageModel),
      }),
    });

    // Consume the stream
    let iterationText = '';
    let hasToolCalls = false;
    const recordsBefore = tracker.getSummary().records.length;

    try {
      for await (const part of result.stream) {
        if (signal?.aborted || stepAbort.signal.aborted) {
          aborted = true;
          break;
        }

        switch (part.type) {
          case 'text-delta':
            iterationText += part.text;
            break;
          case 'tool-call': {
            hasToolCalls = true;
            if (isProviderExecuted(part)) {
              providerToolCalls += 1;
              toolCounters.total += 1;
              toolCounters.perIteration += 1;
            }
            break;
          }
          case 'tool-result': {
            // Provider-executed results never pass through the local
            // wrapper, so the loop fires the post-tool-use hook and
            // caches the normalised result here (agent-do-cgh).
            if (!isProviderExecuted(part)) break;
            const raw = 'output' in part ? (part as { output?: unknown }).output : undefined;
            const normalised = normaliseProviderToolResult(
              (part as { toolName?: string }).toolName ?? 'unknown',
              raw,
            );
            const callId = (part as { toolCallId?: string }).toolCallId;
            if (callId && !resultCache.has(callId)) resultCache.set(callId, normalised);
            if (config.hooks?.onPostToolUse) {
              await config.hooks.onPostToolUse({
                toolName: (part as { toolName?: string }).toolName ?? 'unknown',
                args: (part as { input?: unknown }).input,
                result: normalised,
                step: i,
                durationMs: 0,
                providerExecuted: true,
              });
            }
            break;
          }
          case 'tool-error': {
            // Provider-side tool errors (agent-do-dul review P2): surface
            // them to the post hook with a bounded ToolResult. Local tool
            // errors keep flowing through the SDK's own response history.
            if (!isProviderExecuted(part)) break;
            const errNormalised = normaliseProviderToolError(
              (part as { toolName?: string }).toolName ?? 'unknown',
              (part as { error?: unknown }).error,
            );
            const errCallId = (part as { toolCallId?: string }).toolCallId;
            if (errCallId && !resultCache.has(errCallId)) resultCache.set(errCallId, errNormalised);
            if (config.hooks?.onPostToolUse) {
              await config.hooks.onPostToolUse({
                toolName: (part as { toolName?: string }).toolName ?? 'unknown',
                args: (part as { input?: unknown }).input,
                result: errNormalised,
                step: i,
                durationMs: 0,
                providerExecuted: true,
              });
            }
            break;
          }
        }
      }
    } catch (err) {
      // An abort inside streamText (including our own hard-cap trip) can
      // bubble out as an AbortError/DOMException. Treat it as a graceful
      // end-of-run instead of a crash — the hook has already recorded
      // every step's usage into the tracker (see PR #65 review fix).
      if (stepAbort.signal.aborted) {
        aborted = true;
      } else {
        throw err;
      }
    } finally {
      if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
    }

    // Fire onUsage for each step the hook recorded during this
    // iteration. Doing it here (rather than inside the hook) keeps
    // onUsage dispatch on the outer event-loop tick and consistent
    // with the pre-#65 contract: one onUsage per step the SDK
    // completed, including the step that triggered an abort.
    if (config.hooks?.onUsage) {
      const freshRecords = tracker.getSummary().records.slice(recordsBefore);
      for (const rec of freshRecords) await config.hooks.onUsage(rec);
    }

    if (aborted) break;

    // Post-hoc tool-limit enforcement for provider-executed calls
    // (agent-do-cgh). See providerToolLimitExceeded.
    if (providerToolLimitExceeded(config, toolCounters, providerToolCalls)) {
      console.warn(
        `[agent-do] Tool-call limit reached (${config.toolLimits?.maxToolCalls} per run, ` +
          `including ${providerToolCalls} provider-executed calls). Stopping the run.`,
      );
      aborted = true;
      break;
    }

    // Get response messages and append to history
    const response = await result.response;
    for (const msg of response.messages) {
      messages.push(msg as ModelMessage);
    }

    // Get final text
    const finalText = await result.text;
    lastText = finalText || iterationText;

    // Step complete hook
    if (config.hooks?.onStepComplete) {
      await config.hooks.onStepComplete({
        step: i,
        hasToolCalls,
        text: lastText,
      });
    }

    // If no tool calls, the agent is done
    if (!hasToolCalls) {
      break;
    }

    // Continue — add continuation prompt
    messages.push({
      role: 'user',
      content:
        'Continue working on the task. If you are done, respond with your final summary without calling any tools.',
    });
  }

  const finalUsage = tracker.getSummary();

  // Complete hook
  if (config.hooks?.onComplete) {
    await config.hooks.onComplete({
      result: lastText,
      totalSteps: finalUsage.steps,
      usage: finalUsage,
      aborted,
    });
  }

  return {
    text: lastText,
    usage: finalUsage,
    steps: outerIterations,
    aborted,
  };
}

/**
 * Stream the agent loop, yielding progress events.
 *
 * If `config.mcpServers` is set, the servers are mounted at the start
 * and closed after the generator completes (or the caller returns early),
 * so MCP subprocesses don't leak.
 *
 * Slash-command dispatch (#76) happens first: when the task starts
 * with `/<name>`, the configured sub-agent's stream is forwarded
 * verbatim (after a single `thinking` announcement so consumers can
 * observe the dispatch). An unknown command yields the listing as the
 * final `text` + `done`, without calling the parent model.
 */
export async function* streamAgentLoop(
  config: AgentConfig,
  task: string,
  context?: string,
  history?: ConversationMessage[],
): AsyncGenerator<ProgressEvent> {
  // Deterministic slash-command dispatch — before any model call,
  // before MCP mount (#76).
  if (config.slashCommands) {
    const parsed = parseSlashCommand(task);
    if (parsed) {
      const sub = config.slashCommands[parsed.name];
      if (sub) {
        // Announce the dispatch via an existing event type so the
        // ProgressEvent union stays unchanged (zero-surface-change).
        // `thinking` is the closest existing semantic — a status line
        // the consumer can render or ignore. Forwarding the sub-agent's
        // stream verbatim then gives a coherent event flow.
        yield {
          type: 'thinking',
          content: `Dispatching "/${parsed.name}" to ${sub.name}…`,
          step: 0,
          totalSteps: 1,
        };
        yield* sub.stream(parsed.rest, context);
        return;
      }

      // Unknown command — listing as the final text, no model call.
      const msg = unknownSlashCommandMessage(parsed.name, config.slashCommands);
      yield { type: 'text', content: msg, step: 0, totalSteps: 0 };
      yield { type: 'done', content: msg, step: 0, totalSteps: 0 };
      return;
    }
  }

  const { config: resolvedConfig, mcp } = await mountConfigMcp(config);
  try {
    yield* streamAgentLoopDirect(resolvedConfig, task, context, history);
  } finally {
    if (mcp) await mcp.close();
  }
}

/**
 * Direct (non-MCP-managing) implementation of {@link streamAgentLoop}.
 * Kept as a private function so MCP lifecycle is handled exactly once
 * by the exported entry point; external callers should stick to
 * `streamAgentLoop`.
 */
async function* streamAgentLoopDirect(
  config: AgentConfig,
  task: string,
  context?: string,
  history?: ConversationMessage[],
): AsyncGenerator<ProgressEvent> {
  const maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const innerStepLimit = config.innerStepLimit ?? DEFAULT_INNER_STEP_LIMIT;
  const signal = config.signal;
  const emitFullResult = config.emitFullResult === true;
  const resultCache: ToolResultCache = new Map();
  const iterationStarts: number[] = [];
  const historyKeepWindow =
    config.historyKeepWindow ?? DEFAULT_HISTORY_KEEP_WINDOW;
  const toolCounters: ToolCallCounters = { total: 0, perIteration: 0 };

  // Usage tracking
  const tracker = new UsageTracker({
    pricing: config.usage?.pricing,
    perRunLimit: config.usage?.limits?.perRun,
    perDayLimit: config.usage?.limits?.perDay,
    onLimitExceeded: config.usage?.onLimitExceeded,
  });

  // Debug surface (#72). Generator can't yield from inside a middleware
  // callback, so we buffer debug events into `debugQueue` and drain
  // them between the explicit `yield` points below. `setupDebug`
  // receives a push-to-queue callback; the caller-facing
  // `AgentConfig.debug.sink` is still called synchronously from
  // within `setupDebug` (that path doesn't go through the queue).
  const debugQueue: ProgressEvent[] = [];
  const debugSurface = setupDebug(config, (ev) => debugQueue.push(ev));
  const model = debugSurface.model;
  function drainDebug(): ProgressEvent[] {
    const drained = debugQueue.slice();
    debugQueue.length = 0;
    return drained;
  }

  // Build system prompt
  const systemPrompt = await buildSystemPrompt(config, context);
  emitSystemPromptDebug(config.debug, debugSurface.emit, systemPrompt);
  for (const ev of drainDebug()) yield ev;

  // Message history — prepend conversation history if provided
  const messages: ModelMessage[] = [];
  if (history) {
    for (const msg of history) {
      messages.push({ role: msg.role, content: msg.content } as ModelMessage);
    }
  }
  messages.push({ role: 'user', content: task });

  let lastText = '';
  let aborted = false;
  // Observed provider-executed (server-side) tool calls for this run
  // (agent-do-cgh). Counted from the stream; never increments from the
  // local wrapper path.
  let providerToolCalls = 0;

  for (let i = 0; i < maxIterations; i++) {
    // Check abort
    if (signal?.aborted) {
      aborted = true;
      yield {
        type: 'error',
        content: 'Aborted',
        step: i,
        totalSteps: maxIterations,
      };
      break;
    }
    // Middleware tags events with the iteration index.
    debugSurface.stepRef.current = i;

    // Step start hook
    if (config.hooks?.onStepStart) {
      const summary = tracker.getSummary();
      const decision = await config.hooks.onStepStart({
        step: i,
        totalSteps: maxIterations,
        tokensSoFar: summary.totalInputTokens + summary.totalOutputTokens,
        costSoFar: summary.totalCost,
      });
      if (decision?.decision === 'stop') {
        break;
      }
    }

    // Check spending limits (skip first iteration)
    if (i > 0 && config.usage?.enabled !== false) {
      const withinLimits = await tracker.checkLimits();
      if (!withinLimits) {
        yield {
          type: 'error',
          content: 'Spending limit exceeded',
          step: i,
          totalSteps: maxIterations,
        };
        break;
      }
    }

    yield {
      type: 'thinking',
      content: `Step ${i + 1}...`,
      step: i,
      totalSteps: maxIterations,
    };

    // Redact stale tool outputs from older iterations before the next
    // model call (#33). The cutoff respects `historyKeepWindow`.
    stripStaleToolOutputs(
      messages,
      cutoffForKeepWindow(iterationStarts, historyKeepWindow),
    );

    iterationStarts.push(messages.length);
    toolCounters.perIteration = 0;

    // Build tools for this step
    const tools = buildTools(config, i, resultCache, toolCounters);

    // Per-step hard spending cap (#31). See runAgentLoopDirect for the
    // full rationale.
    const stepAbort = new AbortController();
    const parentSignal = signal;
    const onParentAbort = () => stepAbort.abort(parentSignal?.reason);
    if (parentSignal) {
      if (parentSignal.aborted) stepAbort.abort(parentSignal.reason);
      else parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
    const onStepEnd = buildOnStepEnd(
      config,
      tracker,
      stepAbort,
      i,
      debugSurface.emit,
    );

    // Call streamText (with the debug-wrapped model if debug is set).
    const result = streamText({
      model,
      instructions: systemPrompt,
      messages,
      tools: Object.keys(tools).length > 0 ? tools : undefined,
      stopWhen: stepCountIs(innerStepLimit),
      abortSignal: stepAbort.signal,
      onStepEnd,
      providerOptions: config.providerOptions,
      prepareStep: ({ messages: stepMsgs }) => ({
        messages: addCacheControl(stepMsgs, config.model as LanguageModel),
      }),
    });

    // Consume the stream and yield events
    let iterationText = '';
    let hasToolCalls = false;
    let hardCapTripped = false;
    const recordsBefore = tracker.getSummary().records.length;

    try {
      for await (const part of result.stream) {
        if (signal?.aborted || stepAbort.signal.aborted) {
          aborted = true;
          if (stepAbort.signal.aborted && !signal?.aborted) hardCapTripped = true;
          break;
        }

        // Drain any debug events the middleware emitted since the
        // last yield. `response-part` events fire from inside
        // `wrapStream`'s TransformStream, which the consumer only
        // sees after we yield back to it.
        for (const ev of drainDebug()) yield ev;

        switch (part.type) {
          case 'text-delta':
            iterationText += part.text;
            yield {
              type: 'thinking',
              content: part.text,
              step: i,
              totalSteps: maxIterations,
            };
            break;

          case 'tool-call': {
            hasToolCalls = true;
            const providerExecuted = isProviderExecuted(part);
            if (providerExecuted) {
              providerToolCalls += 1;
              toolCounters.total += 1;
              toolCounters.perIteration += 1;
            }
            const toolArgs =
              'args' in part
                ? part.args
                : 'input' in part
                  ? (part as Record<string, unknown>).input
                  : undefined;
            yield {
              type: 'tool-call',
              content: `Called ${part.toolName}`,
              toolName: part.toolName,
              toolArgs,
              ...(providerExecuted ? { providerExecuted: true } : {}),
              step: i,
              totalSteps: maxIterations,
            };
            break;
          }

          case 'tool-result': {
            const rawResult =
              'result' in part
                ? (part as { result?: unknown }).result
                : 'output' in part
                  ? (part as Record<string, unknown>).output
                  : undefined;
            const partToolCallId =
              'toolCallId' in part
                ? (part as { toolCallId?: string }).toolCallId
                : undefined;
            // Provider-executed results never pass through the local
            // wrapper — cache the normalised result and fire the post
            // hook here so enrichment and hooks cover them (agent-do-cgh).
            // `onPreToolUse` is deliberately not fired: its deny/stop
            // decisions would be unenforceable after server-side execution.
            if (isProviderExecuted(part)) {
              const normalisedProviderResult = normaliseProviderToolResult(
                part.toolName,
                rawResult,
              );
              if (partToolCallId && !resultCache.has(partToolCallId)) {
                resultCache.set(partToolCallId, normalisedProviderResult);
              }
              if (config.hooks?.onPostToolUse) {
                await config.hooks.onPostToolUse({
                  toolName: part.toolName,
                  args: 'input' in part ? (part as { input?: unknown }).input : undefined,
                  result: normalisedProviderResult,
                  step: i,
                  durationMs: 0,
                  providerExecuted: true,
                });
              }
            }
            const cached = partToolCallId
              ? resultCache.get(partToolCallId)
              : undefined;

            // Prefer the cached structured result (produced by our wrapper).
            // `rawResult` is the AI SDK's serialised form of `modelContent`
            // — we already have the richer view if the tool ran through the
            // wrapper, but fall back to the raw string for tools that somehow
            // bypass it.
            // `JSON.stringify` returns `undefined` for undefined/function/
            // symbol values and throws on circular references; fall back
            // to `String(...)` to keep the event-stream contract a string.
            const safeStringify = (v: unknown): string => {
              if (typeof v === 'string') return v;
              try {
                const json = JSON.stringify(v);
                if (typeof json === 'string') return json;
              } catch { /* fall through */ }
              return String(v);
            };
            const summary = cached ? cached.userSummary : safeStringify(rawResult);
            const data = cached?.data;
            const blocked = cached?.blocked;

            yield {
              type: 'tool-result',
              content: '',
              toolName: part.toolName,
              summary,
              data,
              blocked,
              // Full raw payload is opt-in — default is summary + data only so
              // secrets and large file contents don't leak through telemetry.
              toolResult: emitFullResult ? (cached ?? rawResult) : undefined,
              ...(isProviderExecuted(part) ? { providerExecuted: true } : {}),
              step: i,
              totalSteps: maxIterations,
            };

            if (partToolCallId) resultCache.delete(partToolCallId);
            break;
          }

          case 'tool-error': {
            // Provider-side tool errors (agent-do-dul review P2): surface
            // them as a bounded tool-result event + post hook. Local tool
            // errors keep flowing through the SDK's own response history.
            if (!isProviderExecuted(part)) break;
            const errName = (part as { toolName?: string }).toolName ?? 'unknown';
            const errNormalised = normaliseProviderToolError(
              errName,
              (part as { error?: unknown }).error,
            );
            const errCallId = (part as { toolCallId?: string }).toolCallId;
            if (errCallId && !resultCache.has(errCallId)) resultCache.set(errCallId, errNormalised);
            if (config.hooks?.onPostToolUse) {
              await config.hooks.onPostToolUse({
                toolName: errName,
                args: 'input' in part ? (part as { input?: unknown }).input : undefined,
                result: errNormalised,
                step: i,
                durationMs: 0,
                providerExecuted: true,
              });
            }
            yield {
              type: 'tool-result',
              content: '',
              toolName: errName,
              summary: errNormalised.userSummary,
              data: errNormalised.data,
              toolResult: emitFullResult ? errNormalised : undefined,
              providerExecuted: true,
              step: i,
              totalSteps: maxIterations,
            };
            break;
          }
        }
      }
      // Drain any trailing debug events emitted during the final
      // stream parts (cache breakdown fires from onStepEnd which
      // runs after the last stream part).
      for (const ev of drainDebug()) yield ev;
    } catch (err) {
      if (stepAbort.signal.aborted) {
        aborted = true;
        if (!signal?.aborted) hardCapTripped = true;
      } else {
        if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
        throw err;
      }
    } finally {
      if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
    }

    // Fire onUsage for every step the hook recorded this iteration,
    // including the step that triggered an abort. This is the per-
    // step-record fix from PR #65 review — before this the abort path
    // never made it into RunResult.usage.
    if (config.hooks?.onUsage) {
      const freshRecords = tracker.getSummary().records.slice(recordsBefore);
      for (const rec of freshRecords) await config.hooks.onUsage(rec);
    }

    if (hardCapTripped) {
      yield {
        type: 'error',
        content: 'Hard spending cap reached',
        step: i,
        totalSteps: maxIterations,
      };
    }

    // Post-hoc tool-limit enforcement for provider-executed calls
    // (agent-do-cgh). See providerToolLimitExceeded.
    if (providerToolLimitExceeded(config, toolCounters, providerToolCalls)) {
      console.warn(
        `[agent-do] Tool-call limit reached (${config.toolLimits?.maxToolCalls} per run, ` +
          `including ${providerToolCalls} provider-executed calls). Stopping the run.`,
      );
      yield {
        type: 'error',
        content: `Tool-call limit reached (${config.toolLimits?.maxToolCalls} per run, including provider-executed calls)`,
        step: i,
        totalSteps: maxIterations,
      };
      aborted = true;
    }

    if (aborted) break;

    // Append response messages
    const response = await result.response;
    for (const msg of response.messages) {
      messages.push(msg as ModelMessage);
    }

    // Get final text
    const finalText = await result.text;
    lastText = finalText || iterationText;

    if (lastText) {
      yield {
        type: 'text',
        content: lastText,
        step: i,
        totalSteps: maxIterations,
      };
    }

    // Step complete hook
    if (config.hooks?.onStepComplete) {
      await config.hooks.onStepComplete({
        step: i,
        hasToolCalls,
        text: lastText,
      });
    }

    yield {
      type: 'step-complete',
      content: `Step ${i + 1} complete`,
      step: i,
      totalSteps: maxIterations,
    };

    // If no tool calls, done
    if (!hasToolCalls) {
      yield {
        type: 'done',
        content: lastText,
        step: i,
        totalSteps: maxIterations,
      };

      // Complete hook
      if (config.hooks?.onComplete) {
        const finalUsage = tracker.getSummary();
        await config.hooks.onComplete({
          result: lastText,
          totalSteps: finalUsage.steps,
          usage: finalUsage,
          aborted: false,
        });
      }

      return;
    }

    // Continue
    messages.push({
      role: 'user',
      content:
        'Continue working on the task. If you are done, respond with your final summary without calling any tools.',
    });
  }

  // Hit max iterations or aborted
  const finalUsage = tracker.getSummary();

  if (!aborted) {
    yield {
      type: 'error',
      content: `Reached maximum ${maxIterations} iterations`,
      step: maxIterations - 1,
      totalSteps: maxIterations,
    };
  }

  if (config.hooks?.onComplete) {
    await config.hooks.onComplete({
      result: lastText,
      totalSteps: finalUsage.steps,
      usage: finalUsage,
      aborted,
    });
  }
}
