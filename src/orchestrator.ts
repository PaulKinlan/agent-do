/**
 * Multi-Agent Orchestrator.
 *
 * Creates a master agent with delegation tools that can assign tasks
 * to worker agents and collect results.
 */

import type { Agent, AgentConfig, ProgressEvent, RunResult, SubAgentUsage } from './types.js';
import { createAgent } from './agent.js';
import { wrapForModel } from './tools/content-guards.js';
import { UsageTracker } from './usage.js';
import type { ToolResult } from './tools/types.js';
import { tool } from 'ai';
import { z } from 'zod';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const s = (schema: z.ZodType): any => schema;

/**
 * Format a sub-agent's spend for the master's userSummary line. Deterministic
 * (fixed decimals) so tests and operator logs are stable.
 *
 * Sub-agent spends are often sub-cent, and `toFixed(4)` rounded them up —
 * $0.00005 printed as "$0.0001", i.e. double the real cost (agent-do-2kn).
 * Six decimals keeps small values honest and still renders exactly for
 * values with four or fewer.
 */
export function formatSubAgentUsage(usage: SubAgentUsage): string {
  return `${usage.inputTokens} in / ${usage.outputTokens} out tokens, ~$${formatCost(usage.estimatedCost)}, ${usage.steps} steps`;
}

/** Render a cost without inflating sub-cent values (see formatSubAgentUsage). */
function formatCost(cost: number): string {
  return String(Number(cost.toFixed(6)));
}

/**
 * Frame a worker's result before the master sees it.
 *
 * A worker is a separate agent whose context is built from whatever it read: files, web pages, tool output.
 * From the master's point of view its result is third-party content, and it arrives as a tool result - the
 * highest-trust position in the prompt. So it gets exactly what MCP responses get (`wrapForModel`): a
 * `<tool_output>` frame the content cannot close, prompt-injection markers redacted, and a size cap.
 * agent-do-4ya; the same class as agent-do-hvz and agent-do-dte.
 *
 * When the caller passes the worker's usage (agent-do-5oz), it travels in `data.workerUsage` and in the
 * `userSummary` so an operator — and the master itself — can see what the delegation cost. It is that
 * worker's own spend: with a shared budget the tracker's ledger also holds the master's and earlier workers'
 * steps, so the orchestrator reports the worker's delta, not the ledger total (agent-do-2kn).
 *
 * The counts travel in `data` so an operator (or a later tool) can see what was cut or redacted without
 * parsing the framed string.
 */
export function frameWorkerResult(
  agentId: string,
  result: string,
  usage?: SubAgentUsage,
): ToolResult {
  const wrapped = wrapForModel(result, { tool: 'delegate_task', path: agentId });
  const size = wrapped.truncated
    ? `${wrapped.totalBytes} bytes, truncated to ${wrapped.includedBytes}`
    : `${wrapped.totalBytes} bytes`;
  const spend = usage ? ` (${formatSubAgentUsage(usage)})` : '';
  return {
    modelContent: wrapped.content,
    userSummary: `[delegate_task] worker "${agentId}" returned ${size}${spend}`,
    data: {
      agentId,
      totalBytes: wrapped.totalBytes,
      includedBytes: wrapped.includedBytes,
      truncated: wrapped.truncated,
      redactedMarkerCount: wrapped.redactedMarkerCount,
      neutralisedDelimiterCount: wrapped.neutralisedDelimiterCount,
      ...(usage ? { workerUsage: usage } : {}),
    },
  };
}

export interface OrchestratorConfig {
  master: AgentConfig;
  workers: AgentConfig[];
  messaging?: {
    send: (from: string, to: string, message: string) => Promise<void>;
    receive: (agentId: string) => Promise<string | null>;
  };
}

export interface Orchestrator {
  readonly master: Agent;
  readonly workers: Map<string, Agent>;
  run(task: string, context?: string): Promise<string>;
  /**
   * Like {@link Orchestrator.run}, but returns the master's full
   * {@link RunResult}. With a shared usage budget (master config sets
   * `usage.limits`), `usage` is the combined master + worker spend
   * (agent-do-5oz).
   */
  runWithResult(task: string, context?: string): Promise<RunResult>;
  stream(task: string, context?: string): AsyncIterable<ProgressEvent>;
  addWorker(config: AgentConfig): Agent;
  removeWorker(agentId: string): void;
}

/**
 * Create a multi-agent orchestrator.
 *
 * The master agent receives delegation tools automatically:
 * - `delegate_task(agentId, task)` — runs a worker and returns its result
 * - `list_agents()` — returns available workers
 * - `get_agent_status(agentId)` — returns whether a worker is idle or busy
 */
export function createOrchestrator(config: OrchestratorConfig): Orchestrator {
  const workers = new Map<string, Agent>();
  const workerConfigs = new Map<string, AgentConfig>();
  const busyWorkers = new Set<string>();

  // Shared usage budget (agent-do-5oz). When the master config sets
  // spending limits, ONE tracker is created here and injected into the
  // master and every worker via AgentConfig.usage.tracker: sub-agent
  // spend is recorded into the same ledger, so the parent's perRun /
  // perDay guards trip on the combined spend mid-run instead of being
  // bypassed by delegation. The tracker lives for the orchestrator's
  // lifetime — the budget spans every run it drives. A master without
  // limits keeps the previous behaviour (each agent tracks itself).
  const masterLimits = config.master.usage?.enabled === false ? undefined : config.master.usage?.limits;
  const sharedTracker =
    masterLimits && (masterLimits.perRun !== undefined || masterLimits.perDay !== undefined)
      ? new UsageTracker({
          pricing: config.master.usage?.pricing,
          perRunLimit: masterLimits.perRun,
          perDayLimit: masterLimits.perDay,
          onLimitExceeded: config.master.usage?.onLimitExceeded,
        })
      : undefined;

  // Apply the shared budget to an agent config. Limits/multiplier are
  // inherited from the master only when the agent doesn't set its own
  // (its own values still arm its local hard-cap hook; the shared
  // tracker's master-derived limits always govern the shared checks).
  function withSharedBudget(cfg: AgentConfig): AgentConfig {
    if (!sharedTracker) return cfg;
    return {
      ...cfg,
      usage: {
        ...cfg.usage,
        tracker: sharedTracker,
        limits: cfg.usage?.limits ?? masterLimits,
        hardLimitMultiplier: cfg.usage?.hardLimitMultiplier ?? config.master.usage?.hardLimitMultiplier,
      },
    };
  }

  // In-memory messaging fallback
  const messageQueues = new Map<string, string[]>();

  const messaging = config.messaging ?? {
    send: async (_from: string, to: string, message: string) => {
      if (!messageQueues.has(to)) {
        messageQueues.set(to, []);
      }
      messageQueues.get(to)!.push(message);
    },
    receive: async (agentId: string) => {
      const queue = messageQueues.get(agentId);
      if (!queue || queue.length === 0) return null;
      return queue.shift()!;
    },
  };

  // Create worker agents
  for (const workerConfig of config.workers) {
    const agent = createAgent(withSharedBudget(workerConfig));
    workers.set(workerConfig.id, agent);
    workerConfigs.set(workerConfig.id, workerConfig);
  }

  // Build delegation tools for the master
  function buildDelegationTools() {
    return {
      delegate_task: tool({
        description:
          'Delegate a task to a worker agent. Returns the worker\'s result when complete.',
        inputSchema: s(z.object({
          agentId: z.string().describe('The ID of the worker agent to delegate to'),
          task: z.string().describe('The task description to send to the worker'),
        })),
        execute: async ({ agentId, task }: { agentId: string; task: string }) => {
          const worker = workers.get(agentId);
          if (!worker) {
            return `Error: No worker found with id "${agentId}". Use list_agents to see available workers.`;
          }
          if (busyWorkers.has(agentId)) {
            return `Error: Worker "${agentId}" is currently busy. Wait for it to finish or use another worker.`;
          }

          busyWorkers.add(agentId);
          try {
            // Notify via messaging
            await messaging.send(config.master.id, agentId, task);
            // runWithResult (not run) so the worker's spend is visible:
            // it goes into the tool result's data below, and — when the
            // master configured usage limits — into the shared tracker
            // the master's own guards check (agent-do-5oz). The worker's
            // RunResult.usage is the worker's own spend, not the shared
            // ledger's running total (agent-do-2kn).
            const { text: result, usage } = await worker.runWithResult(task);
            // Internal plumbing, not model-facing: the unframed copy stays as it is.
            await messaging.send(agentId, config.master.id, result);
            return frameWorkerResult(agentId, result, {
              inputTokens: usage.totalInputTokens,
              outputTokens: usage.totalOutputTokens,
              estimatedCost: usage.totalCost,
              steps: usage.steps,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // The worker's message is third-party content too - it can quote whatever the worker read - so it
            // is framed rather than spliced into the result (agent-do-4ya, same rule as the success path).
            const framed = wrapForModel(message, { tool: 'delegate_task', path: agentId });
            return {
              modelContent: `Error: Worker "${agentId}" failed:\n${framed.content}`,
              userSummary: `[delegate_task] worker "${agentId}" failed`,
              data: {
                error: true,
                agentId,
                totalBytes: framed.totalBytes,
                truncated: framed.truncated,
                redactedMarkerCount: framed.redactedMarkerCount,
                neutralisedDelimiterCount: framed.neutralisedDelimiterCount,
              },
            };
          } finally {
            busyWorkers.delete(agentId);
          }
        },
      }),

      list_agents: tool({
        description: 'List all available worker agents and their current status.',
        inputSchema: s(z.object({})),
        execute: async () => {
          const agents: Array<{ id: string; name: string; status: string }> = [];
          for (const [id, agent] of workers) {
            agents.push({
              id,
              name: agent.name,
              status: busyWorkers.has(id) ? 'busy' : 'idle',
            });
          }
          return JSON.stringify(agents);
        },
      }),

      get_agent_status: tool({
        description: 'Get the current status of a specific worker agent.',
        inputSchema: s(z.object({
          agentId: z.string().describe('The ID of the worker agent'),
        })),
        execute: async ({ agentId }: { agentId: string }) => {
          const worker = workers.get(agentId);
          if (!worker) {
            return `Error: No worker found with id "${agentId}".`;
          }
          return JSON.stringify({
            id: agentId,
            name: worker.name,
            status: busyWorkers.has(agentId) ? 'busy' : 'idle',
          });
        },
      }),
    };
  }

  // Create master agent with delegation tools merged in
  function buildMaster(): Agent {
    const delegationTools = buildDelegationTools();
    const masterConfig: AgentConfig = withSharedBudget({
      ...config.master,
      tools: {
        ...config.master.tools,
        ...delegationTools,
      },
    });
    return createAgent(masterConfig);
  }

  let master = buildMaster();

  return {
    get master() {
      return master;
    },

    get workers() {
      return workers;
    },

    async run(task: string, context?: string): Promise<string> {
      return master.run(task, context);
    },

    runWithResult(task: string, context?: string): Promise<RunResult> {
      return master.runWithResult(task, context);
    },

    stream(task: string, context?: string): AsyncIterable<ProgressEvent> {
      return master.stream(task, context);
    },

    addWorker(workerConfig: AgentConfig): Agent {
      const agent = createAgent(withSharedBudget(workerConfig));
      workers.set(workerConfig.id, agent);
      workerConfigs.set(workerConfig.id, workerConfig);
      // Rebuild master so delegation tools see the new worker
      master = buildMaster();
      return agent;
    },

    removeWorker(agentId: string): void {
      workers.delete(agentId);
      workerConfigs.delete(agentId);
      busyWorkers.delete(agentId);
      // Rebuild master so delegation tools no longer see the worker
      master = buildMaster();
    },
  };
}
