/**
 * Demo: Automated Code Reviewer
 *
 * Reads source files from a directory and produces a structured
 * code review report covering security, bugs, readability, and
 * best practices.
 *
 * Usage:
 *   npm start /path/to/project
 *   npm start                    # reviews current directory
 *
 * Run: npm start
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createAgent,
  createFileTools,
  type AgentHooks,
} from 'agent-do';
import { FilesystemMemoryStore } from 'agent-do/stores/filesystem';
import { createAnthropic } from '@ai-sdk/anthropic';

// ═══════════════════════════════════════════════
//  Configuration
// ═══════════════════════════════════════════════

const MODEL_ID = 'claude-sonnet-4-6';
const AGENT_ID = 'reviewer';
const OUTPUT_DIR = '.data/reviews';

// ═══════════════════════════════════════════════
//  Setup
// ═══════════════════════════════════════════════

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required.');
  console.error('  export ANTHROPIC_API_KEY=sk-ant-...');
  process.exit(1);
}

// Target directory from args or cwd
const targetDir = path.resolve(process.argv[2] || process.cwd());

if (!fs.existsSync(targetDir)) {
  console.error(`Error: Directory not found: ${targetDir}`);
  process.exit(1);
}

if (!fs.statSync(targetDir).isDirectory()) {
  console.error(`Error: Not a directory: ${targetDir}`);
  process.exit(1);
}

console.log('');
console.log('='.repeat(55));
console.log('  Automated Code Reviewer');
console.log('='.repeat(55));
console.log('');
console.log(`  Target:  ${targetDir}`);
console.log(`  Model:   ${MODEL_ID}`);
console.log(`  Mode:    READ-ONLY`);
console.log('');

// ═══════════════════════════════════════════════
//  Read-only filesystem store for the source code
// ═══════════════════════════════════════════════

// The review target is mounted read-only -- the agent cannot modify the code.
// FilesystemMemoryStore scopes to {baseDir}/{agentId}/, so we use the parent
// Use targetDir as baseDir with '.' as agentId — read_file("src/index.ts")
// resolves to targetDir/src/index.ts. Path traversal (../) is blocked by
// FilesystemMemoryStore's containment check against baseDir.
const sourceStore = new FilesystemMemoryStore(targetDir, { readOnly: true });
const SOURCE_AGENT_ID = '.';

// A writable store for saving the review output
const outputStore = new FilesystemMemoryStore(OUTPUT_DIR);
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Combine both into tools:
//   - Source code tools are read-only
//   - Output tools can write (for saving the review)
const sourceTools = createFileTools(sourceStore, SOURCE_AGENT_ID);
const outputTools = createFileTools(outputStore, AGENT_ID);

// Build a combined toolset with clear naming
const tools: Record<string, any> = {};

// Source tools: keep only read-only operations
for (const [name, tool] of Object.entries(sourceTools)) {
  // Keep read-only tools from source, skip write/delete
  if (name === 'read_file' || name === 'list_directory' || name === 'grep_file' || name === 'find_files') {
    tools[name] = tool;
  }
}

// Output tools: add write capability with a distinct name
tools['save_review'] = outputTools['write_file'];

// ═══════════════════════════════════════════════
//  Lifecycle hooks for progress logging
// ═══════════════════════════════════════════════

let filesRead = 0;
let toolCalls = 0;

const hooks: AgentHooks = {
  onPreToolUse: async (event) => {
    toolCalls++;
    if (event.toolName === 'read_file') {
      filesRead++;
      const args = event.args as { path: string };
      console.log(`  [reading] ${args.path}`);
    } else if (event.toolName === 'find_files') {
      console.log('  [scanning] Discovering project structure...');
    } else if (event.toolName === 'list_directory') {
      const args = event.args as { path?: string };
      console.log(`  [listing] ${args.path || '.'}`);
    } else if (event.toolName === 'grep_file') {
      const args = event.args as { pattern: string };
      console.log(`  [searching] Pattern: "${args.pattern}"`);
    } else if (event.toolName === 'save_review') {
      const args = event.args as { path: string };
      console.log(`  [saving] Review to ${args.path}`);
    }
    return { decision: 'allow' };
  },

  onStepStart: async (event) => {
    if (event.step === 0) {
      console.log('  Analyzing code...');
      console.log('');
    }
    return { decision: 'continue' };
  },

  onUsage: async (record) => {
    console.log(`  [usage] step ${record.step}: ${record.inputTokens.toLocaleString()} in + ${record.outputTokens.toLocaleString()} out ($${record.estimatedCost.toFixed(4)})`);
  },

  onComplete: async (event) => {
    console.log('');
    console.log('-'.repeat(55));
    console.log('  Review complete');
    console.log(`    Files read:  ${filesRead}`);
    console.log(`    Tool calls:  ${toolCalls}`);
    console.log(`    Steps:       ${event.totalSteps}`);
    console.log(`    Tokens:      ${(event.usage.totalInputTokens + event.usage.totalOutputTokens).toLocaleString()}`);
    console.log(`    Cost:        $${event.usage.totalCost.toFixed(4)}`);
    console.log('-'.repeat(55));
  },
};

// ═══════════════════════════════════════════════
//  Create the reviewer agent
// ═══════════════════════════════════════════════

const agent = createAgent({
  id: AGENT_ID,
  name: 'Code Reviewer',
  model: createAnthropic({ apiKey })(MODEL_ID) as any,
  systemPrompt: `You are an expert code reviewer. You analyze source code for issues across several categories.

Your review process:
1. First, use find_files to discover the project structure
2. Read the key source files (prioritize .ts, .js, .py, .go, .rs, .java, .tsx, .jsx files)
3. Skip node_modules, .git, dist, build, and other generated directories
4. Analyze each file for issues
5. Produce a structured review report
6. Save the review using save_review

Your review should cover:

## Security
- Injection vulnerabilities (SQL, XSS, command injection)
- Authentication and authorization issues
- Hardcoded secrets or credentials
- Unsafe deserialization
- Path traversal risks

## Bugs & Logic Errors
- Null/undefined handling
- Off-by-one errors
- Race conditions
- Unhandled error cases
- Type coercion issues

## Code Quality
- Readability and naming conventions
- Code duplication
- Function length and complexity
- Dead code
- Missing error handling

## Best Practices
- Dependency management
- Configuration management
- Logging and observability
- Testing coverage (if tests exist)
- Documentation

Format your review as a markdown document with clear severity levels:
- **CRITICAL**: Security vulnerabilities or bugs that could cause data loss
- **WARNING**: Issues that should be fixed but are not immediately dangerous
- **SUGGESTION**: Improvements for readability, maintainability, or performance

For each issue, include:
- File path and line reference (approximate is fine)
- Description of the issue
- Suggested fix or approach

End with a summary section listing counts by severity.`,
  tools,
  maxIterations: 15,
  hooks,
  usage: { enabled: true },
});

// ═══════════════════════════════════════════════
//  Run the review
// ═══════════════════════════════════════════════

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const reviewFilename = `review-${timestamp}.md`;

const task = `Review the code in this project directory.

Explore the file structure, read the important source files, and produce a comprehensive code review.

After completing your review, save it using save_review with path "${reviewFilename}".

Focus on the most impactful findings. If there are many files, prioritize the core source files over configuration and boilerplate.`;

console.log('-'.repeat(55));
console.log('');

// Stream for real-time output
let finalText = '';

for await (const event of agent.stream(task)) {
  switch (event.type) {
    case 'text':
      finalText += event.content;
      break;

    case 'done':
      break;

    case 'error':
      console.log(`  [error] ${event.content}`);
      break;

    // tool-call and tool-result handled by hooks
  }
}

// Print the final summary
console.log('');
console.log('='.repeat(55));
console.log('  Review Summary');
console.log('='.repeat(55));
console.log('');
console.log(finalText);
console.log('');

const reviewPath = path.join(OUTPUT_DIR, AGENT_ID, reviewFilename);
if (fs.existsSync(reviewPath)) {
  console.log(`  Full review saved to: ${reviewPath}`);
} else {
  console.log(`  Review output directory: ${OUTPUT_DIR}`);
}
console.log('');
