#!/usr/bin/env node

/**
 * agent-do CLI
 *
 * Usage:
 *   npx agent-do "prompt"                     One-shot task
 *   npx agent-do                              Interactive chat
 *   echo "prompt" | npx agent-do              Piped input
 *   echo "context" | npx agent-do "prompt"    Piped context merged with prompt
 *   npx agent-do run script.ts                Run a script that exports an agent
 *   npx agent-do eval evals/basic.ts          Run eval cases
 */

import { parseArgs, type ParsedArgs } from './cli/args.js';
import { runPromptMode } from './cli/prompt.js';
import { runScriptMode } from './cli/script.js';
import { runEvalMode } from './cli/eval-cmd.js';

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
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function printHelp(): void {
  console.log(`
agent-do — run AI agents from the command line

Usage:
  npx agent-do [options] [prompt]          One-shot task or interactive chat
  npx agent-do run <file>                  Run a script that exports an agent
  npx agent-do eval <file|dir> [options]   Run eval cases

Piping:
  echo "context" | npx agent-do "prompt"   Merge piped input with prompt
  cat file.txt | npx agent-do "Summarize"  Pipe file contents as context

Options:
  --provider <name>      anthropic | google | openai | ollama (default: anthropic)
  --model <id>           Model ID (default: provider-specific)
  --system <prompt>      System prompt (default: "You are a helpful assistant.")
  --memory <dir>         Memory directory (default: .agent-do/)
  --read-only            No filesystem writes
  --max-iterations <n>   Max loop iterations (default: 20)
  --no-tools             Disable file tools
  --verbose              Show tool calls and step details
  --json                 Output as JSON
  -h, --help             Show this help

Eval options:
  --output <format>      console | json | csv (default: console)
  --compare <providers>  Compare across providers (comma-separated)
  --concurrency <n>      Parallel case execution (default: 1)

Environment:
  ANTHROPIC_API_KEY      Required for Anthropic models
  GOOGLE_GENERATIVE_AI_API_KEY   Required for Google models
  OPENAI_API_KEY         Required for OpenAI models

Examples:
  npx agent-do "What is TypeScript?"
  npx agent-do --provider google --model gemini-2.5-flash "Hello"
  cat README.md | npx agent-do "Summarize this"
  npx agent-do run my-agent.ts
  npx agent-do eval evals/basic.ts
  npx agent-do eval evals/ --compare anthropic,google --output json
`);
}

main();
