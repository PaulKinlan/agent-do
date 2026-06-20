/**
 * Live-tier eval cases — real provider, real cost, opt-in (`npm run eval:live`).
 *
 * These measure *quality*, not plumbing. They are NOT run in CI. The harness
 * skips the live tier with a clear message when no provider API key is set.
 *
 * Keep the case set small and the models cheap by default — every case makes
 * real API calls, and `llm-rubric` adds a judge call on top.
 */
import type { EvalCase } from '../src/eval/types.js';

export const LIVE_SYSTEM_PROMPT =
  'You are a concise, helpful assistant with access to file tools for notes.';

export const LIVE_CASES: EvalCase[] = [
  {
    name: 'knows the capital of France',
    input: 'What is the capital of France? Reply with just the city name.',
    assert: [
      { type: 'contains', value: 'Paris' },
      { type: 'max-steps', max: 2 },
    ],
  },
  {
    name: 'saves and persists a note',
    input: 'Save a note that says "Standup at 9am" to standup.md, then confirm.',
    assert: [
      { type: 'tool-called', tool: 'write_file' },
      { type: 'file-contains', path: 'standup.md', value: '9am' },
      { type: 'max-steps', max: 4 },
    ],
  },
  {
    name: 'explains a concept clearly (rubric)',
    input: 'Explain what a mutex is to a junior developer in two sentences.',
    assert: [
      {
        type: 'llm-rubric',
        rubric:
          'The explanation is accurate, concise, and avoids unnecessary jargon. ' +
          'It should convey mutual exclusion / preventing concurrent access to a resource.',
        score: 'pass-fail',
      },
    ],
  },
];
