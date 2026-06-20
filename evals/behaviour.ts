/**
 * Mock-tier eval cases — deterministic, free, run in CI (`npm run eval`).
 *
 * Each case carries its own scripted `responses` so the harness builds a
 * fresh `createMockModel()` per case. The mock consumes its response queue
 * in order, so per-case isolation keeps the suite maintainable as cases are
 * added or removed (no fragile cross-case queue indexing).
 *
 * IMPORTANT — what these verify vs. what they don't:
 *
 *   ✓ Loop plumbing: prompt → tool call → result → assertion.
 *   ✓ Tool dispatch, file persistence, step budgets, permission wiring.
 *   ✗ Model intelligence. The mock returns canned text regardless of what
 *     the tools actually returned.
 *
 * Measure *quality* with the live tier (`evals/quality.live.ts`).
 */
import type { Assertion } from '../src/eval/types.js';
import type { MockResponse } from '../src/testing/index.js';
import type { PricingTable } from '../src/types.js';

export interface MockEvalCase {
  name: string;
  input: string;
  /** Scripted model outputs, consumed in order across the loop steps. */
  responses: MockResponse[];
  assert: Assertion[];
  runs?: number;
}

export const MOCK_SYSTEM_PROMPT =
  'You are a helpful assistant with access to file tools for note-taking.';

/**
 * Zero-cost pricing for the mock model so the runner doesn't log
 * "no pricing entry" warnings and `max-cost` assertions stay meaningful
 * (0 <= maxUsd).
 */
export const MOCK_PRICING: PricingTable = {
  'mock-eval': { input: 0, output: 0 },
};

export const MOCK_CASES: MockEvalCase[] = [
  {
    name: 'answers a factual question',
    input: 'What is the capital of France? Reply with just the city.',
    responses: [{ text: 'Paris' }],
    assert: [
      { type: 'contains', value: 'Paris' },
      { type: 'not-contains', value: 'Berlin' },
      { type: 'max-steps', max: 1 },
    ],
  },
  {
    name: 'writes a note via write_file and persists it',
    input: 'Save a note that says "Buy milk" to shopping.md',
    responses: [
      { toolCalls: [{ toolName: 'write_file', args: { path: 'shopping.md', content: 'Buy milk' } }] },
      { text: 'Saved the note to shopping.md.' },
    ],
    assert: [
      { type: 'tool-called', tool: 'write_file' },
      { type: 'tool-not-called', tool: 'delete_file' },
      { type: 'tool-args', tool: 'write_file', args: { path: 'shopping.md' } },
      { type: 'file-exists', path: 'shopping.md' },
      { type: 'file-contains', path: 'shopping.md', value: 'Buy milk' },
      { type: 'max-steps', max: 2 },
    ],
  },
  {
    name: 'does not call tools for a pure-text answer',
    input: 'What is 2 + 2? Reply with just the number.',
    responses: [{ text: '4' }],
    assert: [
      { type: 'contains', value: '4' },
      { type: 'tool-not-called', tool: 'read_file' },
      { type: 'tool-not-called', tool: 'write_file' },
      { type: 'max-steps', max: 1 },
    ],
  },
  {
    name: 'completes within a step budget',
    input: 'Say hello.',
    responses: [{ text: 'Hello!' }],
    assert: [{ type: 'max-steps', max: 1 }],
  },
];
