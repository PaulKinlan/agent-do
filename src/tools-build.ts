/**
 * Tool construction: permission checks, hooks and structured-result normalisation.
 *
 * Split out of `src/loop.ts` (agent-do-4os). Everything that decides whether a tool
 * may run, what the model sees and what the operator's stream sees lives here; the
 * loop only asks for `buildTools`.
 */

import type { ToolSet } from 'ai';
import type { AgentConfig } from './types.js';
import { evaluatePermission } from './permissions.js';
import { createSkillTools } from './skills.js';
import { createRoutineTools } from './routines.js';
import { normaliseToolResult, type ToolResult } from './tools/types.js';


/**
 * Per-run cache of structured tool results, keyed by `toolCallId` assigned
 * by the model. Populated by the wrapper inside {@link wrapToolWithPermissions}
 * when a tool executes, read by the stream loop when a `tool-result` event
 * is about to be yielded — so the event carries `summary`, `data`, and
 * `blocked` even though the model only ever saw `modelContent`.
 *
 * The map is local to a single run and garbage-collected with it.
 */
export type ToolResultCache = Map<string, ToolResult>;

/**
 * Wrap a tool's execute function with permission checks, hooks, and the
 * structured-result normalisation layer (issue #48).
 *
 * The wrapper:
 *   1. Enforces `permissions` and the `onPreToolUse` hook (unchanged).
 *   2. Calls the tool's `execute`.
 *   3. Normalises the return value into a {@link ToolResult} so every tool
 *      has both a model-facing view (`modelContent`) and an operator-facing
 *      view (`userSummary`) without having to know the split.
 *   4. Stashes the full ToolResult in `resultCache`, keyed by the AI SDK's
 *      `toolCallId`, so the stream layer can enrich the `tool-result`
 *      progress event with `summary`, `data`, and `blocked`.
 *   5. Returns only `modelContent` back to the AI SDK. The model therefore
 *      sees a short, sanitised string; the operator sees the rich summary
 *      on stderr; programmatic consumers get structured `data`.
 *
 * Tools that return denial / block results (`{ blocked: true, ... }`) and
 * the permission-denied / hook-denied branches all route through the same
 * normalisation so rendering is consistent.
 */
/**
 * Shared counters for per-run and per-iteration tool-call limits (#27, M-03).
 *
 * The outer loop holds one instance for the whole run and resets
 * `perIteration` at the top of each iteration.
 */
export interface ToolCallCounters {
  total: number;
  perIteration: number;
}

function wrapToolWithPermissions(
  name: string,
  originalTool: ToolSet[string],
  config: AgentConfig,
  step: number,
  resultCache: ToolResultCache,
  counters: ToolCallCounters,
): ToolSet[string] {
  const originalExecute = originalTool.execute;
  if (!originalExecute) return originalTool;

  const exec = originalExecute;

  const limits = config.toolLimits;

  return {
    ...originalTool,
    execute: async (args: unknown, options: unknown) => {
      let effectiveArgs = args;
      const toolCallId = (options as { toolCallId?: string } | undefined)
        ?.toolCallId;

      const recordAndReturn = (tr: ToolResult): string => {
        if (toolCallId) resultCache.set(toolCallId, tr);
        return tr.modelContent;
      };

      // Tool-call rate limits (#27). Count *before* permission/hook checks
      // so a denied call still consumes a slot — otherwise an injected
      // prompt could probe the permission surface for free. Limits are
      // enforced as `> cap` because the counter is incremented first.
      counters.total += 1;
      counters.perIteration += 1;
      if (
        limits?.maxToolCalls !== undefined &&
        counters.total > limits.maxToolCalls
      ) {
        return recordAndReturn({
          modelContent: `Error: tool-call limit reached (${limits.maxToolCalls} per run). Stop calling tools.`,
          userSummary: `[${name}] DENIED — per-run tool limit hit (${limits.maxToolCalls})`,
          data: { blocked: true, reason: 'tool-limit-run', tool: name, limit: limits.maxToolCalls },
          blocked: true,
        });
      }
      if (
        limits?.maxToolCallsPerIteration !== undefined &&
        counters.perIteration > limits.maxToolCallsPerIteration
      ) {
        return recordAndReturn({
          modelContent: `Error: per-iteration tool-call limit reached (${limits.maxToolCallsPerIteration}). Produce a final answer instead.`,
          userSummary: `[${name}] DENIED — per-iteration tool limit hit (${limits.maxToolCallsPerIteration})`,
          data: { blocked: true, reason: 'tool-limit-iteration', tool: name, limit: limits.maxToolCallsPerIteration },
          blocked: true,
        });
      }

      // Permission check
      if (config.permissions) {
        const allowed = await evaluatePermission(
          name,
          effectiveArgs,
          config.permissions,
        );
        if (!allowed) {
          return recordAndReturn({
            modelContent: `Error: Permission denied for tool "${name}".`,
            userSummary: `[${name}] DENIED by permission policy`,
            data: { blocked: true, reason: 'permission-denied', tool: name },
            blocked: true,
          });
        }
      }

      // Pre-tool-use hook
      if (config.hooks?.onPreToolUse) {
        const decision = await config.hooks.onPreToolUse({
          toolName: name,
          args: effectiveArgs,
          step,
        });

        if (decision) {
          if (decision.decision === 'deny') {
            return recordAndReturn({
              modelContent: `Error: Tool "${name}" was denied${decision.reason ? `: ${decision.reason}` : ''}.`,
              userSummary: `[${name}] DENIED by hook${decision.reason ? ` — ${decision.reason}` : ''}`,
              data: { blocked: true, reason: 'hook-denied', tool: name, hookReason: decision.reason },
              blocked: true,
            });
          }
          if (decision.decision === 'stop') {
            return recordAndReturn({
              modelContent: `Error: Execution stopped${decision.reason ? `: ${decision.reason}` : ''}.`,
              userSummary: `[${name}] STOP from hook${decision.reason ? ` — ${decision.reason}` : ''}`,
              data: { blocked: true, reason: 'hook-stop', tool: name, hookReason: decision.reason },
              blocked: true,
            });
          }
          if (decision.modifiedArgs !== undefined) {
            effectiveArgs = decision.modifiedArgs;
          }
        }
      }

      // Execute
      const startTime = Date.now();
      const raw = await (exec as Function)(effectiveArgs, options);
      const durationMs = Date.now() - startTime;

      const normalised = normaliseToolResult(raw);

      // Post-tool-use hook — receives the normalised ToolResult so consumers
      // have a consistent shape. (Raw returns still flow through via
      // `data` if the tool supplied it.)
      if (config.hooks?.onPostToolUse) {
        await config.hooks.onPostToolUse({
          toolName: name,
          args: effectiveArgs,
          result: normalised,
          step,
          durationMs,
        });
      }

      return recordAndReturn(normalised);
    },
  } as typeof originalTool;
}

/**
 * Build the full tool set with permission wrapping.
 *
 * The caller supplies `resultCache` so that tool results flow back to the
 * event stream for enrichment (see {@link wrapToolWithPermissions}).
 */
export function buildTools(
  config: AgentConfig,
  step: number,
  resultCache: ToolResultCache,
  counters: ToolCallCounters,
): ToolSet {
  const tools: ToolSet = {};

  // Add user-provided tools
  if (config.tools) {
    for (const [name, t] of Object.entries(config.tools)) {
      tools[name] = wrapToolWithPermissions(name, t, config, step, resultCache, counters);
    }
  }

  // Add skill tools if a store is provided. `install_skill` is only
  // registered when `allowSkillInstall` is explicitly set — see #24.
  if (config.skills) {
    const skillTools = createSkillTools(config.skills, {
      allowInstall: config.allowSkillInstall === true,
    });
    for (const [name, t] of Object.entries(skillTools)) {
      tools[name] = wrapToolWithPermissions(name, t, config, step, resultCache, counters);
    }
  }

  // Add routine tools if a store is provided. `save_routine` is only
  // registered when `allowRoutineSave` is explicitly set — see #77.
  if (config.routines) {
    const routineTools = createRoutineTools(config.routines, {
      allowSave: config.allowRoutineSave === true,
    });
    for (const [name, t] of Object.entries(routineTools)) {
      tools[name] = wrapToolWithPermissions(name, t, config, step, resultCache, counters);
    }
  }

  return tools;
}
