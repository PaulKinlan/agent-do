/**
 * Demo: Interactive CLI Assistant
 *
 * A multi-turn interactive assistant with persistent file storage,
 * streaming output, lifecycle hooks, and session-level usage tracking.
 *
 * Features:
 *   - FilesystemMemoryStore for persistent memory (.data/)
 *   - Conversation history across messages
 *   - File tools (read/write/search/list)
 *   - Streaming mode shows tool calls as they happen
 *   - Lifecycle hooks log usage and cost after each run
 *   - Session summary on exit
 *
 * Run: npm start
 */

import * as readline from 'node:readline';
import {
  createAgent,
  createFileTools,
  type ConversationMessage,
  type AgentHooks,
  type RunUsage,
} from 'agent-do';
import { FilesystemMemoryStore } from 'agent-do/stores/filesystem';
import { resolveProvider, announce } from './provider.js';

// ═══════════════════════════════════════════════
//  Configuration
// ═══════════════════════════════════════════════

const AGENT_ID = 'assistant';
const DATA_DIR = '.data';

// ═══════════════════════════════════════════════
//  Session state
// ═══════════════════════════════════════════════

const history: ConversationMessage[] = [];
let sessionInputTokens = 0;
let sessionOutputTokens = 0;
let sessionCost = 0;
let messageCount = 0;

// ═══════════════════════════════════════════════
//  Setup
// ═══════════════════════════════════════════════

// Resolve provider from env — Anthropic / Google / OpenAI. See
// ./provider.ts for the full env surface (DEMO_PROVIDER to force,
// per-provider key vars, DEMO_MASTER_MODEL override).
const resolved = await resolveProvider();
announce(resolved);
const model = resolved.model(resolved.defaults.master);

// Persistent filesystem store
const store = new FilesystemMemoryStore(DATA_DIR);

// File tools for the agent
const fileTools = createFileTools(store, AGENT_ID);

// Lifecycle hooks
const hooks: AgentHooks = {
  onStepStart: async (event) => {
    if (event.step > 0) {
      console.log(`  [step ${event.step + 1}] ${event.tokensSoFar.toLocaleString()} tokens so far, $${event.costSoFar.toFixed(4)} spent`);
    }
    return { decision: 'continue' };
  },

  onUsage: async (record) => {
    sessionInputTokens += record.inputTokens;
    sessionOutputTokens += record.outputTokens;
    sessionCost += record.estimatedCost;
    console.log(`  [usage] step ${record.step}: ${record.inputTokens.toLocaleString()} in + ${record.outputTokens.toLocaleString()} out ($${record.estimatedCost.toFixed(4)})`);
  },

  onComplete: async (event) => {
    console.log(`  [complete] ${event.totalSteps} step(s), $${event.usage.totalCost.toFixed(4)} this turn`);
  },
};

// Create the agent
const agent = createAgent({
  id: AGENT_ID,
  name: 'Assistant',
  model,
  systemPrompt: `You are a helpful interactive assistant with access to a persistent filesystem.

You can:
- Save and read notes, documents, and any text files
- Search across your stored files
- List directory contents
- Organize information into folders

Files are stored persistently in your workspace. They survive across sessions.
Be helpful, concise, and proactive about organizing information.
When the user asks you to remember something, save it to a file.
When searching, use grep_file and find_files to locate content.`,
  tools: fileTools,
  maxIterations: 10,
  hooks,
  usage: { enabled: true },
});

// ═══════════════════════════════════════════════
//  Welcome message
// ═══════════════════════════════════════════════

console.log('');
console.log('='.repeat(55));
console.log('  Interactive CLI Assistant');
console.log('='.repeat(55));
console.log('');
console.log('  I am an interactive assistant with persistent storage.');
console.log('  I can save notes, search files, and remember things');
console.log('  across our conversation.');
console.log('');
console.log('  What I can do:');
console.log('    - Save and read files      (write_file, read_file)');
console.log('    - Search file contents      (grep_file)');
console.log('    - Browse stored files        (list_directory, find_files)');
console.log('    - Delete files               (delete_file)');
console.log('');
console.log('  Files are stored in .data/ and persist across sessions.');
console.log('');
console.log('  Type a message to chat. Type "quit" or press Ctrl+C to exit.');
console.log('');
console.log('-'.repeat(55));
console.log('');

// ═══════════════════════════════════════════════
//  Session summary
// ═══════════════════════════════════════════════

function printSessionSummary(): void {
  console.log('');
  console.log('='.repeat(55));
  console.log('  Session Summary');
  console.log('='.repeat(55));
  console.log(`  Messages exchanged: ${messageCount} (${messageCount / 2} exchanges)`);
  console.log(`  Input tokens:       ${sessionInputTokens.toLocaleString()}`);
  console.log(`  Output tokens:      ${sessionOutputTokens.toLocaleString()}`);
  console.log(`  Total tokens:       ${(sessionInputTokens + sessionOutputTokens).toLocaleString()}`);
  console.log(`  Estimated cost:     $${sessionCost.toFixed(4)}`);
  console.log('='.repeat(55));
  console.log('');
}

// ═══════════════════════════════════════════════
//  Interactive loop
// ═══════════════════════════════════════════════

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  printSessionSummary();
  process.exit(0);
});

async function chat(userMessage: string): Promise<void> {
  messageCount++;

  console.log('');

  // Stream the response
  let fullResponse = '';
  let printedHeader = false;

  for await (const event of agent.stream(userMessage, undefined, history)) {
    switch (event.type) {
      case 'tool-call': {
        const argsStr = event.toolArgs
          ? JSON.stringify(event.toolArgs, null, 0).slice(0, 120)
          : '';
        console.log(`  [tool-call] ${event.toolName}(${argsStr})`);
        break;
      }

      case 'tool-result': {
        const resultStr = event.toolResult
          ? String(event.toolResult).slice(0, 120)
          : '';
        console.log(`  [tool-result] ${resultStr}${String(event.toolResult || '').length > 120 ? '...' : ''}`);
        break;
      }

      case 'text': {
        if (!printedHeader) {
          console.log('');
          process.stdout.write('  Assistant: ');
          printedHeader = true;
        }
        process.stdout.write(event.content);
        fullResponse += event.content;
        break;
      }

      case 'done': {
        if (printedHeader) {
          console.log('');
        }
        break;
      }

      case 'error': {
        console.log(`  [error] ${event.content}`);
        break;
      }
    }
  }

  // Update conversation history
  history.push({ role: 'user', content: userMessage });
  if (fullResponse) {
    history.push({ role: 'assistant', content: fullResponse });
    messageCount++;
  }

  console.log('');
}

function prompt(): void {
  rl.question('You: ', async (input) => {
    const trimmed = input.trim();

    if (!trimmed) {
      prompt();
      return;
    }

    if (trimmed.toLowerCase() === 'quit' || trimmed.toLowerCase() === 'exit') {
      printSessionSummary();
      rl.close();
      process.exit(0);
    }

    try {
      await chat(trimmed);
    } catch (err) {
      console.error(`  [error] ${err instanceof Error ? err.message : String(err)}`);
    }

    prompt();
  });
}

prompt();
