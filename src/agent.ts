import type {
  Agent,
  AgentConfig,
  ConversationMessage,
  ProgressEvent,
  RunResult,
} from './types.js';
import { runAgentLoop, streamAgentLoop } from './loop.js';
import { validateSlashCommands, markHasSlashCommands } from './slash-commands.js';
import { validateScheduledTasks } from './scheduled-tasks.js';
import { validatePermissionConfig } from './permissions.js';

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
  // Mode 'ask' with no callback used to silently allow every tool; reject it at construction so a config
  // that reads as "ask me first" cannot quietly become "allow everything" (agent-do-40r).
  if (config.permissions) {
    validatePermissionConfig(config.permissions);
  }

  let abortController: AbortController | null = null;

  const agent: Agent = {
    get id() {
      return config.id;
    },
    get name() {
      return config.name;
    },

    async runWithResult(
      task: string,
      context?: string,
      history?: ConversationMessage[],
    ): Promise<RunResult> {
      abortController = new AbortController();
      const mergedConfig: AgentConfig = {
        ...config,
        signal: config.signal ?? abortController.signal,
      };

      try {
        return await runAgentLoop(mergedConfig, task, context, history);
      } finally {
        abortController = null;
      }
    },

    async run(task: string, context?: string, history?: ConversationMessage[]): Promise<string> {
      const result = await agent.runWithResult(task, context, history);
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
