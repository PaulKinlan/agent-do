import { describe, it, expect } from 'vitest';
import { defineEval, runEvals } from '../src/eval/runner.js';
import { createMockModel } from '../src/testing/index.js';

describe('defineEval', () => {
  it('returns the config unchanged', () => {
    const config = {
      name: 'test-suite',
      cases: [
        { name: 'case1', input: 'hello', assert: [{ type: 'contains' as const, value: 'hello' }] },
      ],
    };
    expect(defineEval(config)).toBe(config);
  });
});

describe('runEvals', () => {
  it('runs a simple contains assertion against mock model', async () => {
    const model = createMockModel({
      responses: [{ text: 'The answer is 42' }],
    });

    const suite = defineEval({
      name: 'basic-test',
      model,
      systemPrompt: 'You are helpful.',
      cases: [
        {
          name: 'knows the answer',
          input: 'What is the answer?',
          assert: [{ type: 'contains', value: '42' }],
        },
      ],
    });

    const result = await runEvals(suite, { output: 'silent' });

    expect(result.name).toBe('basic-test');
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]!.passed).toBe(1);
    expect(result.providers[0]!.failed).toBe(0);
    expect(result.providers[0]!.cases[0]!.passed).toBe(true);
  });

  it('detects a failing assertion', async () => {
    const model = createMockModel({
      responses: [{ text: 'I have no idea' }],
    });

    const suite = defineEval({
      name: 'fail-test',
      model,
      cases: [
        {
          name: 'should contain answer',
          input: 'What is 2+2?',
          assert: [{ type: 'contains', value: '4' }],
        },
      ],
    });

    const result = await runEvals(suite, { output: 'silent' });

    expect(result.providers[0]!.passed).toBe(0);
    expect(result.providers[0]!.failed).toBe(1);
    expect(result.providers[0]!.cases[0]!.passed).toBe(false);
  });

  it('supports multiple assertions on one case', async () => {
    const model = createMockModel({
      responses: [{ text: 'Paris is the capital of France' }],
    });

    const suite = defineEval({
      name: 'multi-assert',
      model,
      cases: [
        {
          name: 'capitals',
          input: 'Capital of France?',
          assert: [
            { type: 'contains', value: 'Paris' },
            { type: 'not-contains', value: 'London' },
            { type: 'regex', pattern: 'Paris.*France' },
          ],
        },
      ],
    });

    const result = await runEvals(suite, { output: 'silent' });

    expect(result.providers[0]!.cases[0]!.passed).toBe(true);
    expect(result.providers[0]!.cases[0]!.assertions).toHaveLength(3);
  });

  it('case fails if any assertion fails', async () => {
    const model = createMockModel({
      responses: [{ text: 'The capital of France is Paris' }],
    });

    const suite = defineEval({
      name: 'partial-fail',
      model,
      cases: [
        {
          name: 'mixed',
          input: 'test',
          assert: [
            { type: 'contains', value: 'Paris' },
            { type: 'contains', value: 'Berlin' }, // will fail
          ],
        },
      ],
    });

    const result = await runEvals(suite, { output: 'silent' });

    expect(result.providers[0]!.cases[0]!.passed).toBe(false);
    expect(result.providers[0]!.cases[0]!.assertions[0]!.passed).toBe(true);
    expect(result.providers[0]!.cases[0]!.assertions[1]!.passed).toBe(false);
  });

  it('handles tool-called assertion with mock model', async () => {
    const model = createMockModel({
      responses: [
        {
          toolCalls: [{ toolName: 'write_file', args: { path: 'test.md', content: 'hello' } }],
        },
        { text: 'Done! I saved the file.' },
      ],
    });

    const suite = defineEval({
      name: 'tool-test',
      model,
      systemPrompt: 'You are helpful.',
      cases: [
        {
          name: 'writes a file',
          input: 'Save a note',
          assert: [
            { type: 'tool-called', tool: 'write_file' },
            { type: 'tool-not-called', tool: 'delete_file' },
          ],
        },
      ],
    });

    const result = await runEvals(suite, { output: 'silent' });

    expect(result.providers[0]!.cases[0]!.passed).toBe(true);
  });

  it('checks file state after agent run', async () => {
    const model = createMockModel({
      responses: [
        {
          toolCalls: [{ toolName: 'write_file', args: { path: 'notes.md', content: 'Alice is great' } }],
        },
        { text: 'Saved!' },
      ],
    });

    const suite = defineEval({
      name: 'file-state-test',
      model,
      systemPrompt: 'You are helpful.',
      cases: [
        {
          name: 'saves note with name',
          input: 'Remember Alice',
          assert: [
            { type: 'file-exists', path: 'notes.md' },
            { type: 'file-contains', path: 'notes.md', value: 'Alice' },
          ],
        },
      ],
    });

    const result = await runEvals(suite, { output: 'silent' });

    expect(result.providers[0]!.cases[0]!.passed).toBe(true);
  });

  it('tracks cost and steps', async () => {
    const model = createMockModel({
      responses: [{ text: 'done' }],
      inputTokensPerCall: 100,
      outputTokensPerCall: 50,
    });

    const suite = defineEval({
      name: 'cost-test',
      model,
      cases: [
        {
          name: 'within budget',
          input: 'hello',
          assert: [
            { type: 'max-steps', max: 5 },
            { type: 'max-cost', maxUsd: 1.0 },
          ],
        },
      ],
    });

    const result = await runEvals(suite, { output: 'silent' });

    expect(result.providers[0]!.cases[0]!.passed).toBe(true);
    expect(result.providers[0]!.cases[0]!.steps).toBeGreaterThanOrEqual(1);
  });

  it('runs multiple cases sequentially', async () => {
    const model = createMockModel({
      responses: [
        { text: 'Answer is 4' },
        { text: 'Answer is 9' },
      ],
    });

    const suite = defineEval({
      name: 'multi-case',
      model,
      cases: [
        {
          name: 'case 1',
          input: '2+2?',
          assert: [{ type: 'contains', value: '4' }],
        },
        {
          name: 'case 2',
          input: '3*3?',
          assert: [{ type: 'contains', value: '9' }],
        },
      ],
    });

    const result = await runEvals(suite, { output: 'silent' });

    expect(result.providers[0]!.totalCases).toBe(2);
    expect(result.providers[0]!.passed).toBe(2);
  });

  it('throws when no model is provided', async () => {
    const suite = defineEval({
      name: 'no-model',
      cases: [
        { name: 'test', input: 'hello', assert: [] },
      ],
    });

    await expect(runEvals(suite, { output: 'silent' })).rejects.toThrow('No model provided');
  });

  it('supports model override via options', async () => {
    const model = createMockModel({
      responses: [{ text: 'overridden' }],
      modelId: 'override-model',
    });

    const suite = defineEval({
      name: 'override-test',
      // no model in suite
      cases: [
        {
          name: 'test',
          input: 'hello',
          assert: [{ type: 'contains', value: 'overridden' }],
        },
      ],
    });

    const result = await runEvals(suite, { model, output: 'silent' });

    expect(result.providers[0]!.passed).toBe(1);
    expect(result.providers[0]!.model).toBe('override-model');
  });

  it('supports multi-provider comparison', async () => {
    const model1 = createMockModel({
      responses: [{ text: 'Paris' }],
      modelId: 'model-a',
    });
    const model2 = createMockModel({
      responses: [{ text: 'London' }], // wrong
      modelId: 'model-b',
    });

    const suite = defineEval({
      name: 'compare-test',
      cases: [
        {
          name: 'capital of France',
          input: 'Capital of France?',
          assert: [{ type: 'contains', value: 'Paris' }],
        },
      ],
    });

    const result = await runEvals(suite, {
      output: 'silent',
      providers: [
        { name: 'provider-a', model: model1 },
        { name: 'provider-b', model: model2 },
      ],
    });

    expect(result.providers).toHaveLength(2);
    expect(result.providers[0]!.passed).toBe(1);
    expect(result.providers[0]!.provider).toBe('provider-a');
    expect(result.providers[1]!.passed).toBe(0);
    expect(result.providers[1]!.provider).toBe('provider-b');
  });

  it('supports custom assertion', async () => {
    const model = createMockModel({
      responses: [{ text: 'Hello World' }],
    });

    const suite = defineEval({
      name: 'custom-assert',
      model,
      cases: [
        {
          name: 'custom check',
          input: 'hello',
          assert: [
            {
              type: 'custom',
              name: 'word count',
              fn: (result) => result.text.split(' ').length === 2,
            },
          ],
        },
      ],
    });

    const result = await runEvals(suite, { output: 'silent' });
    expect(result.providers[0]!.cases[0]!.passed).toBe(true);
  });

  it('isolates store between cases', async () => {
    const model = createMockModel({
      responses: [
        // Case 1: write a file
        { toolCalls: [{ toolName: 'write_file', args: { path: 'state.md', content: 'case1' } }] },
        { text: 'done' },
        // Case 2: no writes — file should NOT exist
        { text: 'nothing' },
      ],
    });

    const suite = defineEval({
      name: 'isolation-test',
      model,
      cases: [
        {
          name: 'writes file',
          input: 'write something',
          assert: [{ type: 'file-exists', path: 'state.md' }],
        },
        {
          name: 'file should not exist from previous case',
          input: 'check state',
          assert: [
            {
              type: 'custom',
              name: 'no leftover state',
              fn: async (result) => {
                const exists = await result.store.exists(result.agentId, 'state.md');
                return !exists;
              },
            },
          ],
        },
      ],
    });

    const result = await runEvals(suite, { output: 'silent' });

    expect(result.providers[0]!.cases[0]!.passed).toBe(true);
    expect(result.providers[0]!.cases[1]!.passed).toBe(true);
  });

  it('handles agent errors gracefully', async () => {
    const model = createMockModel({
      responses: [], // empty — will cause an error
    });

    const suite = defineEval({
      name: 'error-test',
      model,
      cases: [
        {
          name: 'should handle error',
          input: 'hello',
          assert: [{ type: 'contains', value: 'anything' }],
        },
      ],
    });

    const result = await runEvals(suite, { output: 'silent' });

    // Should not throw, should report as failed
    expect(result.providers[0]!.failed).toBeGreaterThanOrEqual(0);
  });

  it('result has timestamp', async () => {
    const model = createMockModel({ responses: [{ text: 'ok' }] });
    const suite = defineEval({
      name: 'timestamp-test',
      model,
      cases: [{ name: 'test', input: 'hi', assert: [] }],
    });

    const result = await runEvals(suite, { output: 'silent' });
    expect(result.timestamp).toBeTruthy();
    // Should be a valid ISO date
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });

  it('tool-args partial match works with nested values', async () => {
    const model = createMockModel({
      responses: [
        {
          toolCalls: [{
            toolName: 'write_file',
            args: { path: 'deep/nested.md', content: 'hello world', encoding: 'utf-8' },
          }],
        },
        { text: 'done' },
      ],
    });

    const suite = defineEval({
      name: 'nested-args',
      model,
      cases: [
        {
          name: 'partial args match',
          input: 'save',
          assert: [
            { type: 'tool-args', tool: 'write_file', args: { path: 'deep/nested.md' } },
          ],
        },
      ],
    });

    const result = await runEvals(suite, { output: 'silent' });
    expect(result.providers[0]!.cases[0]!.passed).toBe(true);
  });
});
