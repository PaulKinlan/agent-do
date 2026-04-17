/**
 * Prompt mode — one-shot task or interactive chat.
 *
 * Supports:
 * - npx agent-do "prompt"           — one-shot
 * - echo "ctx" | npx agent-do "p"   — piped context + prompt
 * - cat file | npx agent-do         — piped as prompt
 * - npx agent-do                    — interactive REPL
 */

import * as readline from 'node:readline';
import type { ParsedArgs } from './args.js';
import { readStdin } from './args.js';
import { resolveModel } from './resolve-model.js';
import { createAgent } from '../agent.js';
import { createWorkspaceTools } from '../tools/workspace-tools.js';
import { createMemoryTools } from '../tools/memory-tools.js';
import { FilesystemMemoryStore } from '../stores/filesystem.js';
import type { ProgressEvent, ConversationMessage } from '../types.js';
import type { ToolSet } from 'ai';

export async function runPromptMode(args: ParsedArgs): Promise<void> {
  const model = await resolveModel(args.provider, args.model);

  // Workspace tools see the working directory (cwd by default).
  // Memory tools are opt-in via --with-memory and give the agent a
  // private scratchpad scoped to its ID.
  let tools: ToolSet | undefined;
  if (!args.noTools) {
    tools = createWorkspaceTools(args.workingDir, { readOnly: args.readOnly });
    if (args.withMemory) {
      const memStore = new FilesystemMemoryStore(args.memoryDir, {
        readOnly: args.readOnly,
      });
      tools = { ...tools, ...createMemoryTools(memStore, 'cli-agent') };
    }
  }

  const agent = createAgent({
    id: 'cli-agent',
    name: 'agent-do',
    model,
    systemPrompt: args.systemPrompt,
    tools,
    maxIterations: args.maxIterations,
    permissions: { mode: 'accept-all' },
    usage: { enabled: true },
  });

  // Read stdin if piped
  const stdinContent = await readStdin();

  // Build the task from prompt + stdin
  const task = buildTask(args.prompt, stdinContent);

  if (task) {
    // One-shot mode
    await runOneShot(agent, task, args);
  } else {
    // Interactive mode
    await runInteractive(agent, args);
  }
}

/**
 * Merge piped stdin with command-line prompt.
 *
 * - Only prompt: use prompt as task
 * - Only stdin: use stdin as task
 * - Both: prompt becomes the instruction, stdin becomes context
 * - Neither: null (interactive mode)
 */
function buildTask(prompt?: string, stdin?: string): string | null {
  if (prompt && stdin) {
    return `${prompt}\n\n---\n\n${stdin}`;
  }
  if (prompt) return prompt;
  if (stdin) return stdin;
  return null;
}

async function runOneShot(
  agent: ReturnType<typeof createAgent>,
  task: string,
  args: ParsedArgs,
): Promise<void> {
  if (args.json) {
    // JSON mode — collect everything, detect errors
    const events: ProgressEvent[] = [];
    let finalText = '';
    let hasError = false;
    let errorMessage = '';

    for await (const event of agent.stream(task)) {
      events.push(event);
      if (event.type === 'done') finalText = event.content;
      if (event.type === 'error') {
        hasError = true;
        errorMessage = event.content;
      }
    }

    console.log(JSON.stringify({
      text: finalText,
      error: hasError ? errorMessage : undefined,
      events: args.verbose ? events : undefined,
    }, null, 2));

    if (hasError) process.exit(1);
    return;
  }

  // Streaming mode — quiet by default, only final answer printed
  for await (const event of agent.stream(task)) {
    switch (event.type) {
      case 'thinking':
        if (args.verbose) {
          process.stdout.write(event.content);
        }
        break;
      case 'tool-call':
        if (args.verbose) {
          console.log(`\n[tool] ${event.toolName}(${truncateArgs(event.toolArgs)})`);
        }
        break;
      case 'tool-result':
        if (args.verbose) {
          console.log(`[result] ${truncate(String(event.toolResult), 200)}`);
        }
        break;
      case 'text':
        // Per-step text — only show in verbose mode to avoid intermediate outputs
        if (args.verbose) {
          console.log(event.content);
        }
        break;
      case 'done':
        // Final answer — always print
        if (!args.verbose) {
          process.stdout.write(event.content);
        }
        process.stdout.write('\n');
        break;
      case 'error':
        console.error(`Error: ${event.content}`);
        process.exit(1);
        break;
    }
  }
}

async function runInteractive(
  agent: ReturnType<typeof createAgent>,
  args: ParsedArgs,
): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const history: ConversationMessage[] = [];

  console.log('agent-do interactive mode. Type "exit" or Ctrl+C to quit.\n');

  const askQuestion = (): Promise<string> => {
    return new Promise((resolve) => {
      rl.question('> ', (answer) => resolve(answer));
    });
  };

  while (true) {
    const input = await askQuestion();
    const trimmed = input.trim();

    if (!trimmed) continue;
    if (trimmed === 'exit' || trimmed === 'quit') break;

    // Pass only prior turns as history — streamAgentLoop appends the current
    // user message from the task parameter, so adding it here would duplicate it
    let response = '';
    for await (const event of agent.stream(trimmed, undefined, history)) {
      switch (event.type) {
        case 'thinking':
          if (args.verbose) {
            process.stdout.write(event.content);
          }
          break;
        case 'tool-call':
          if (args.verbose) {
            console.log(`\n[tool] ${event.toolName}(${truncateArgs(event.toolArgs)})`);
          }
          break;
        case 'tool-result':
          if (args.verbose) {
            console.log(`[result] ${truncate(String(event.toolResult), 200)}`);
          }
          break;
        case 'text':
          if (args.verbose) {
            console.log(event.content);
          }
          break;
        case 'done':
          response = event.content;
          if (!args.verbose) {
            process.stdout.write(response);
          }
          process.stdout.write('\n\n');
          break;
        case 'error':
          console.error(`Error: ${event.content}\n`);
          break;
      }
    }

    // Add both turns to history AFTER the run completes
    history.push({ role: 'user', content: trimmed });
    if (response) {
      history.push({ role: 'assistant', content: response });
    }
  }

  rl.close();
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

function truncateArgs(args: unknown): string {
  const s = JSON.stringify(args);
  return truncate(s, 100);
}
