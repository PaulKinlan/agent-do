/**
 * Multi-Agent Orchestrator.
 *
 * Creates a master agent with delegation tools that can assign tasks
 * to worker agents and collect results.
 */

import type { Agent, AgentConfig, ProgressEvent } from './types.js';
import { createAgent } from './agent.js';
import { wrapForModel } from './tools/content-guards.js';
import type { ToolResult } from './tools/types.js';
import { tool } from 'ai';
import { z } from 'zod';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const s = (schema: z.ZodType): any => schema;

/**
 * Frame a worker's result before the master sees it.
 *
 * A worker is a separate agent whose context is built from whatever it read: files, web pages, tool output.
 * From the master's point of view its result is third-party content, and it arrives as a tool result - the
 * highest-trust position in the prompt. So it gets exactly what MCP responses get (`wrapForModel`): a
 * `<tool_output>` frame the content cannot close, prompt-injection markers redacted, and a size cap.
 * agent-do-4ya; the same class as agent-do-hvz and agent-do-dte.
 *
 * The counts travel in `data` so an operator (or a later tool) can see what was cut or redacted without
 * parsing the framed string.
 */
export function frameWorkerResult(agentId: string, result: string): ToolResult {
  const wrapped = wrapForModel(result, { tool: 'delegate_task', path: agentId });
  const size = wrapped.truncated
    ? `${wrapped.totalBytes} bytes, truncated to ${wrapped.includedBytes}`
    : `${wrapped.totalBytes} bytes`;
  return {
    modelContent: wrapped.content,
    userSummary: `[delegate_task] worker "${agentId}" returned ${size}`,
    data: {
      agentId,
      totalBytes: wrapped.totalBytes,
      includedBytes: wrapped.includedBytes,
      truncated: wrapped.truncated,
      redactedMarkerCount: wrapped.redactedMarkerCount,
      neutralisedDelimiterCount: wrapped.neutralisedDelimiterCount,
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
    const agent = createAgent(workerConfig);
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
            const result = await worker.run(task);
            // Internal plumbing, not model-facing: the unframed copy stays as it is.
            await messaging.send(agentId, config.master.id, result);
            return frameWorkerResult(agentId, result);
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
    const masterConfig: AgentConfig = {
      ...config.master,
      tools: {
        ...config.master.tools,
        ...delegationTools,
      },
    };
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

    stream(task: string, context?: string): AsyncIterable<ProgressEvent> {
      return master.stream(task, context);
    },

    addWorker(workerConfig: AgentConfig): Agent {
      const agent = createAgent(workerConfig);
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
