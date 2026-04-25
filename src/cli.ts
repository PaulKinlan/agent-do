#!/usr/bin/env node

/**
 * agent-do CLI
 *
 * Usage:
 *   npx agent-do "prompt"                     One-shot task
 *   npx agent-do                              Interactive chat
 *   echo "prompt" | npx agent-do              Piped input
 *   echo "context" | npx agent-do "prompt"    Piped context merged with prompt
 *   npx agent-do create <name> [options]      Create a saved agent
 *   npx agent-do list                         List saved agents
 *   npx agent-do run <name-or-file> [task]    Run a saved agent or script
 *   npx agent-do eval evals/basic.ts          Run eval cases
 */

import { parseArgs, type ParsedArgs } from './cli/args.js';
import { runPromptMode } from './cli/prompt.js';
import { runScriptMode } from './cli/script.js';
import { runEvalMode } from './cli/eval-cmd.js';
import { createSavedAgent, listSavedAgents } from './cli/agents.js';
import { runScheduledTasksMode } from './cli/scheduled-tasks-cmd.js';

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  try {
    switch (args.command) {
      case 'prompt':
        await runPromptMode(args);
        break;
      case 'run':
        await runScriptMode(args);
        break;
      case 'eval':
        await runEvalMode(args);
        break;
      case 'create':
        await createSavedAgent(args);
        break;
      case 'list':
        await listSavedAgents();
        break;
      case 'scheduled-tasks':
        await runScheduledTasksMode(args);
        break;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function printHelp(): void {
  console.log(`
agent-do — run AI agents from the command line

⚠️  WARNING: agent-do is NOT sandboxed. The agent can read, write, edit, and
    delete files in your working directory. Use --read-only to block writes
    or --no-tools to disable all file access. Proceed with caution.

Usage:
  npx agent-do [options] [prompt]          One-shot task or interactive chat
  npx agent-do create <name> [options]     Create a reusable agent config
  npx agent-do list                        List saved agents
  npx agent-do run <name|file> [task]      Run a saved agent or script file
  npx agent-do eval <file|dir> [options]   Run eval cases
  npx agent-do scheduled-tasks <action>    Manage cron-scheduled agent runs
                                           (run|start|status|install)

Piping:
  echo "context" | npx agent-do "prompt"   Merge piped input with prompt
  cat file.txt | npx agent-do "Summarize"  Pipe file contents as context

Options:
  --provider <name>      anthropic | google | openai | ollama (default: anthropic)
  --model <id>           Model ID (default: provider-specific)
  --system <prompt>      System prompt (default: "You are a helpful assistant.")
  --cwd <dir>            Working directory for workspace tools (default: current dir)
  --memory <dir>         Memory directory for --with-memory (default: .agent-do/)
  --with-memory          Enable memory tools (memory_read/write — agent scratchpad)
  --read-only            Block all writes (workspace + memory)
  --exclude <globs>      Extra deny-list patterns (gitignore-style, comma-separated)
  --include-sensitive    Bypass built-in sensitive-file deny list (.env, .ssh, etc.)
  --max-iterations <n>   Max loop iterations (default: 20)
  --no-tools             Disable all file tools
  --verbose              Show thinking, tool calls, and per-step summaries (stderr)
  --show-content         With --verbose: also print each tool's full result
  --log-level <level>    silent | info | verbose | debug | trace (default: info).
                         'debug' adds system prompt, messages, cache metrics,
                         and request metadata. 'trace' adds every raw stream
                         part. Overrides --verbose / --show-content.
  --json                 Output as JSON
  -h, --help             Show this help

Tools:
  Workspace tools (read_file, write_file, list_directory, grep_file, find_files,
  edit_file, delete_file) are enabled by default, rooted at --cwd. They operate
  on real project files — the agent sees what you see.

  Sensitive files are blocked by default (.env*, *.pem/*.key, .ssh/**, .aws/**,
  .git/hooks/** and credential material). Writes to .git/** and node_modules/**
  are blocked too. Add your own with --exclude (comma-separated globs) or a
  .agent-doignore file at the working-directory root. --include-sensitive
  opts out of the built-in defaults.

  Memory tools (memory_read, memory_write, memory_list, memory_delete,
  memory_search) are a separate, optional scratchpad for the agent's own notes.
  Enable them with --with-memory. They're scoped per-agent and kept in --memory.

Logs:
  In --verbose mode, each tool call emits a structured one-line summary to
  stderr. The final answer still goes to stdout so you can pipe it. Full raw
  tool output is withheld by default to keep secrets out of CI logs; pass
  --show-content to include it.

  --log-level debug adds a layer below verbose: the resolved system prompt,
  the message list sent to the model per step, per-step cache read/write
  tokens, and request metadata. --log-level trace adds every raw stream
  part (text-delta, tool-call, finish) to that. Expect big output —
  redirect stderr to a file.

Eval options:
  --output <format>      console | json | csv (default: console)
  --compare <providers>  Compare across providers (comma-separated)
  --concurrency <n>      Parallel case execution (default: 1)

Scheduled tasks (#79):
  npx agent-do scheduled-tasks run <id> --script ./agent.ts --yes
      Run a single task once. Uses a lock file so two runs can't overlap.
  npx agent-do scheduled-tasks start --script ./agent.ts --yes
      Foreground scheduler — ticks every minute, fires matching tasks.
  npx agent-do scheduled-tasks status [--script ./agent.ts]
      Show last-run times and status per task.
  npx agent-do scheduled-tasks install --script ./agent.ts --yes
      Print a crontab block you can paste into \`crontab -e\`.

Environment:
  ANTHROPIC_API_KEY      Required for Anthropic models
  GOOGLE_GENERATIVE_AI_API_KEY   Required for Google models
  OPENAI_API_KEY         Required for OpenAI models

Other providers:
  The CLI ships with Anthropic, Google, OpenAI, and Ollama built in.
  For Mistral, Groq, Cohere, OpenRouter, Bedrock, etc., import agent-do
  as a library and pass any Vercel AI SDK LanguageModel:

    import { Agent } from 'agent-do';
    import { createMistral } from '@ai-sdk/mistral';
    const agent = new Agent({ model: createMistral()('mistral-large-latest') });

  See https://sdk.vercel.ai/providers for the full list.

Examples:
  npx agent-do "What is TypeScript?"
  npx agent-do create code-reviewer --provider anthropic --system "Review code for bugs"
  npx agent-do run code-reviewer "Review this function"
  npx agent-do list
  cat README.md | npx agent-do "Summarize this"
  npx agent-do eval evals/basic.ts --compare anthropic,google --output json
`);
}

main();
