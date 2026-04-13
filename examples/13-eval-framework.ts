/**
 * Example 13: Eval Framework
 *
 * Demonstrates how to define eval cases, run them against a model,
 * and check agent quality with assertions.
 *
 * Usage:
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   npx tsx examples/13-eval-framework.ts
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { defineEval, runEvals } from 'agent-do/eval';

const anthropic = createAnthropic();

const suite = defineEval({
  name: 'basic-assistant-eval',
  model: anthropic('claude-haiku-4-5'),
  systemPrompt: 'You are a helpful assistant with access to file tools for note-taking.',
  cases: [
    // Phase 1: Basic text assertions
    {
      name: 'knows basic math',
      input: 'What is 2 + 2? Reply with just the number.',
      assert: [
        { type: 'contains', value: '4' },
        { type: 'not-contains', value: '5' },
      ],
    },
    {
      name: 'knows capitals',
      input: 'What is the capital of France? Reply with just the city name.',
      assert: [
        { type: 'contains', value: 'Paris' },
        { type: 'regex', pattern: 'Paris' },
      ],
    },

    // Phase 2: Tool call assertions
    {
      name: 'saves a note using write_file',
      input: 'Save a note that says "Meeting at 3pm" to meetings.md',
      assert: [
        { type: 'tool-called', tool: 'write_file' },
        { type: 'tool-not-called', tool: 'delete_file' },
        { type: 'file-exists', path: 'meetings.md' },
        { type: 'file-contains', path: 'meetings.md', value: '3pm' },
      ],
    },

    // Performance constraints
    {
      name: 'completes efficiently',
      input: 'Say hello',
      assert: [
        { type: 'max-steps', max: 3 },
        { type: 'max-cost', maxUsd: 0.05 },
      ],
    },

    // Custom assertion
    {
      name: 'response is not too long',
      input: 'What is TypeScript in one sentence?',
      assert: [
        {
          type: 'custom',
          name: 'under 500 chars',
          fn: (result) => result.text.length < 500,
        },
      ],
    },
  ],
});

// Run and print results
const result = await runEvals(suite);

// Exit with code 1 if any case failed
const anyFailed = result.providers.some(p => p.failed > 0);
if (anyFailed) process.exit(1);
