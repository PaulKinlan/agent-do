/**
 * Demo: Multi-Agent Research Pipeline
 *
 * A master agent coordinates a Researcher and Writer to produce
 * a polished research report on any topic.
 *
 * Usage:
 *   npm start "Rust programming language"
 *   npm start                              # prompts for a topic
 *
 * Run: npm start
 */

import * as readline from 'node:readline';
import {
  createOrchestrator,
  createFileTools,
} from 'agent-do';
import { FilesystemMemoryStore } from 'agent-do/stores/filesystem';
import { createAnthropic } from '@ai-sdk/anthropic';

// ═══════════════════════════════════════════════
//  Configuration
// ═══════════════════════════════════════════════

const DATA_DIR = '.data';
const MASTER_MODEL = 'claude-sonnet-4-6';
const WORKER_MODEL = 'claude-haiku-4-5';

// ═══════════════════════════════════════════════
//  Setup
// ═══════════════════════════════════════════════

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required.');
  console.error('  export ANTHROPIC_API_KEY=sk-ant-...');
  process.exit(1);
}

const provider = createAnthropic({ apiKey });

// Persistent filesystem store for the master (to save reports)
const store = new FilesystemMemoryStore(DATA_DIR);
const masterFileTools = createFileTools(store, 'master');

// ═══════════════════════════════════════════════
//  Build the orchestrator
// ═══════════════════════════════════════════════

console.log('');
console.log('='.repeat(55));
console.log('  Multi-Agent Research Pipeline');
console.log('='.repeat(55));
console.log('');
console.log('  Agents:');
console.log(`    Master:     ${MASTER_MODEL} (coordinates work)`);
console.log(`    Researcher: ${WORKER_MODEL} (gathers information)`);
console.log(`    Writer:     ${WORKER_MODEL} (drafts the report)`);
console.log('');

const orchestrator = createOrchestrator({
  master: {
    id: 'master',
    name: 'Master',
    model: provider(MASTER_MODEL) as any,
    systemPrompt: `You are a master agent coordinating a research pipeline.

Your workflow:
1. Receive a topic from the user
2. Delegate research to the "researcher" agent with a clear research brief
3. Review the research results
4. Delegate writing to the "writer" agent, passing the research findings and asking for a structured report
5. Save the final report using write_file to "reports/<topic-slug>.md"

Available workers:
- researcher: Gathers comprehensive information, key facts, history, and current state of a topic
- writer: Takes research notes and produces a polished, well-structured markdown report

Always delegate to both workers. Do not write the report yourself.
Save the final report to a file before responding.`,
    tools: masterFileTools,
    maxIterations: 8,
    hooks: {
      onPreToolUse: async (event) => {
        if (event.toolName === 'delegate_task') {
          const args = event.args as { agentId: string; task: string };
          const taskPreview = args.task.length > 80
            ? args.task.slice(0, 80) + '...'
            : args.task;
          console.log('');
          console.log(`  >> Master delegating to ${args.agentId.toUpperCase()}`);
          console.log(`     Task: "${taskPreview}"`);
          console.log(`     ${args.agentId === 'researcher' ? 'Researcher working...' : 'Writer drafting...'}`);
        } else if (event.toolName === 'write_file') {
          const args = event.args as { path: string };
          console.log(`  >> Master saving report to ${args.path}`);
        }
        return { decision: 'allow' };
      },
      onPostToolUse: async (event) => {
        if (event.toolName === 'delegate_task') {
          const args = event.args as { agentId: string };
          const resultStr = String(event.result);
          const preview = resultStr.length > 100
            ? resultStr.slice(0, 100) + '...'
            : resultStr;
          console.log(`     ${args.agentId === 'researcher' ? 'Researcher' : 'Writer'} finished (${event.durationMs}ms)`);
          console.log(`     Result preview: ${preview}`);
        }
      },
      onUsage: async (record) => {
        console.log(`  [master-usage] step ${record.step}: ${record.inputTokens.toLocaleString()} in + ${record.outputTokens.toLocaleString()} out ($${record.estimatedCost.toFixed(4)})`);
      },
      onComplete: async (event) => {
        console.log('');
        console.log('-'.repeat(55));
        console.log('  Pipeline complete');
        console.log(`    Steps:  ${event.totalSteps}`);
        console.log(`    Tokens: ${(event.usage.totalInputTokens + event.usage.totalOutputTokens).toLocaleString()}`);
        console.log(`    Cost:   $${event.usage.totalCost.toFixed(4)}`);
        console.log('-'.repeat(55));
      },
    },
    usage: { enabled: true },
  },
  workers: [
    {
      id: 'researcher',
      name: 'Researcher',
      model: provider(WORKER_MODEL) as any,
      systemPrompt: `You are a research specialist. When given a topic, provide comprehensive research including:

- Overview and definition
- Key history and milestones
- Current state and recent developments
- Major players, tools, or organizations involved
- Strengths, weaknesses, and common criticisms
- Future outlook and trends

Be thorough but concise. Present findings as structured notes with clear headings.
Cite specific facts, dates, and numbers where possible.`,
      maxIterations: 3,
    },
    {
      id: 'writer',
      name: 'Writer',
      model: provider(WORKER_MODEL) as any,
      systemPrompt: `You are a writing specialist. When given research notes, produce a polished markdown report with:

- A clear title (# heading)
- An executive summary (2-3 sentences)
- Well-organized sections with ## headings
- Key takeaways or conclusions at the end

Write in a clear, professional tone. Use bullet points for lists of facts.
The report should be self-contained and readable without the original research notes.`,
      maxIterations: 3,
    },
  ],
});

// ═══════════════════════════════════════════════
//  Get the topic
// ═══════════════════════════════════════════════

async function getTopic(): Promise<string> {
  // Check command line args (skip node and script path)
  const args = process.argv.slice(2);
  if (args.length > 0) {
    return args.join(' ');
  }

  // Prompt interactively
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question('  Enter a research topic: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ═══════════════════════════════════════════════
//  Run the pipeline
// ═══════════════════════════════════════════════

const topic = await getTopic();

if (!topic) {
  console.error('  Error: No topic provided.');
  process.exit(1);
}

console.log('');
console.log('='.repeat(55));
console.log(`  Researching: "${topic}"`);
console.log('='.repeat(55));

const task = `Research and write a comprehensive report about: ${topic}

Steps:
1. Delegate research to the researcher agent
2. Delegate writing to the writer agent, passing the research results
3. Save the final report to reports/${topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}.md
4. Return a brief summary of the report`;

// Stream events for real-time progress
let finalText = '';
let currentStep = -1;

for await (const event of orchestrator.stream(task)) {
  switch (event.type) {
    case 'thinking':
      if (event.step !== undefined && event.step !== currentStep) {
        currentStep = event.step;
        console.log(`\n  -- Master step ${currentStep + 1} --`);
      }
      break;

    case 'tool-call':
      // Delegation logging handled by hooks above
      if (event.toolName !== 'delegate_task' && event.toolName !== 'write_file') {
        console.log(`  [tool-call] ${event.toolName}`);
      }
      break;

    case 'tool-result':
      // Results logging handled by hooks above
      break;

    case 'text':
      finalText += event.content;
      break;

    case 'done':
      break;

    case 'error':
      console.log(`  [error] ${event.content}`);
      break;
  }
}

// Print the final summary
console.log('');
console.log('='.repeat(55));
console.log('  Final Summary');
console.log('='.repeat(55));
console.log('');
console.log(finalText);
console.log('');
