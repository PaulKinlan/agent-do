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
  npx agent-do create <name> [options]     Create a reusable agent config
  npx agent-do list                        List saved agents
  npx agent-do run <name|file> [task]      Run a saved agent or script file
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
  --verbose              Show thinking, tool calls, and per-step text (quiet by default)
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
