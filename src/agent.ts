import type { Agent, AgentConfig, ConversationMessage, ProgressEvent } from './types.js';
import { runAgentLoop, streamAgentLoop } from './loop.js';
import { validateScheduledTasks } from './scheduled-tasks.js';

/**
 * Create an Agent instance from configuration.
 *
 * Returns an agent with run() and stream() methods that drive the
 * autonomous agent loop. Supports conversation history for multi-turn.
 */
export function createAgent(config: AgentConfig): Agent {
  // Fail loud on misconfigured scheduled tasks (#79). Invalid cron
  // expressions or duplicate IDs should surface at construction time,
  // not silently on the first tick hours later.
  if (config.scheduledTasks !== undefined) {
    validateScheduledTasks(config.scheduledTasks);
  }
  let abortController: AbortController | null = null;

  return {
    get id() {
      return config.id;
    },
    get name() {
      return config.name;
    },

    async run(task: string, context?: string, history?: ConversationMessage[]): Promise<string> {
      abortController = new AbortController();
      const mergedConfig: AgentConfig = {
        ...config,
        signal: config.signal ?? abortController.signal,
      };

      const result = await runAgentLoop(mergedConfig, task, context, history);
      abortController = null;
      return result.text;
    },

    stream(task: string, context?: string, history?: ConversationMessage[]): AsyncIterable<ProgressEvent> {
      abortController = new AbortController();
      const mergedConfig: AgentConfig = {
        ...config,
        signal: config.signal ?? abortController.signal,
      };

      return streamAgentLoop(mergedConfig, task, context, history);
    },

    abort() {
      abortController?.abort();
      abortController = null;
    },
  };
}
