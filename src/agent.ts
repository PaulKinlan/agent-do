import type { Agent, AgentConfig, ConversationMessage, ProgressEvent } from './types.js';
import { runAgentLoop, streamAgentLoop } from './loop.js';
import { validateSlashCommands, markHasSlashCommands } from './slash-commands.js';
import { validateScheduledTasks } from './scheduled-tasks.js';

/**
 * Create an Agent instance from configuration.
 *
 * Returns an agent with run() and stream() methods that drive the
 * autonomous agent loop. Supports conversation history for multi-turn.
 *
 * When `config.slashCommands` is present it is validated immediately:
 * keys must match `/^[a-zA-Z0-9_-]+$/`, values must be `Agent`
 * instances, and no sub-agent may itself define `slashCommands`
 * (nested `/a/b` dispatch is disallowed — #76).
 */
export function createAgent(config: AgentConfig): Agent {
  const slashError = validateSlashCommands(config.slashCommands);
  if (slashError) {
    throw new Error(`Invalid agent config: ${slashError}`);
  }
  // Scheduled tasks are validated up front so a typo in a cron expression
  // surfaces at construction, not on the first firing (#79).
  if (config.scheduledTasks) {
    validateScheduledTasks(config.scheduledTasks);
  }

  let abortController: AbortController | null = null;

  const agent: Agent = {
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

  // Stamp the marker AFTER construction so the returned agent is the
  // value a parent might place in its own `slashCommands`. A parent's
  // `createAgent` then rejects this agent as a nested slash-command
  // agent (#76). Non-enumerable via markHasSlashCommands.
  if (config.slashCommands) {
    markHasSlashCommands(agent);
  }

  return agent;
}
