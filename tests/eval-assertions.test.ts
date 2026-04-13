import { describe, it, expect } from 'vitest';
import { evaluateAssertion } from '../src/eval/assertions.js';
import type { CaseRunResult, Assertion } from '../src/eval/types.js';
import { InMemoryMemoryStore } from '../src/stores/in-memory.js';

function makeResult(overrides: Partial<CaseRunResult> = {}): CaseRunResult {
  return {
    text: overrides.text ?? 'Hello world',
    steps: overrides.steps ?? 1,
    cost: overrides.cost ?? 0.001,
    durationMs: overrides.durationMs ?? 100,
    toolCalls: overrides.toolCalls ?? [],
    store: overrides.store ?? new InMemoryMemoryStore(),
    agentId: overrides.agentId ?? 'test-agent',
    aborted: overrides.aborted ?? false,
  };
}

describe('contains assertion', () => {
  it('passes when text contains value', async () => {
    const r = await evaluateAssertion({ type: 'contains', value: 'Hello' }, makeResult());
    expect(r.passed).toBe(true);
  });

  it('fails when text does not contain value', async () => {
    const r = await evaluateAssertion({ type: 'contains', value: 'Goodbye' }, makeResult());
    expect(r.passed).toBe(false);
    expect(r.message).toContain('does not contain');
  });

  it('is case-sensitive', async () => {
    const r = await evaluateAssertion({ type: 'contains', value: 'hello' }, makeResult({ text: 'Hello' }));
    expect(r.passed).toBe(false);
  });
});

describe('not-contains assertion', () => {
  it('passes when text does not contain value', async () => {
    const r = await evaluateAssertion({ type: 'not-contains', value: 'Goodbye' }, makeResult());
    expect(r.passed).toBe(true);
  });

  it('fails when text contains value', async () => {
    const r = await evaluateAssertion({ type: 'not-contains', value: 'Hello' }, makeResult());
    expect(r.passed).toBe(false);
  });
});

describe('regex assertion', () => {
  it('passes when text matches pattern', async () => {
    const r = await evaluateAssertion({ type: 'regex', pattern: 'Hello \\w+' }, makeResult());
    expect(r.passed).toBe(true);
  });

  it('fails when text does not match', async () => {
    const r = await evaluateAssertion({ type: 'regex', pattern: '^Goodbye' }, makeResult());
    expect(r.passed).toBe(false);
  });

  it('supports flags', async () => {
    const r = await evaluateAssertion({ type: 'regex', pattern: 'hello', flags: 'i' }, makeResult());
    expect(r.passed).toBe(true);
  });

  it('handles invalid regex gracefully', async () => {
    const r = await evaluateAssertion({ type: 'regex', pattern: '[invalid' }, makeResult());
    expect(r.passed).toBe(false);
    expect(r.message).toContain('Invalid regex');
  });
});

describe('json-schema assertion', () => {
  it('passes for valid JSON matching schema', async () => {
    const r = await evaluateAssertion(
      {
        type: 'json-schema',
        schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
      },
      makeResult({ text: '{"name": "Alice"}' }),
    );
    expect(r.passed).toBe(true);
  });

  it('fails for missing required field', async () => {
    const r = await evaluateAssertion(
      { type: 'json-schema', schema: { type: 'object', required: ['name'] } },
      makeResult({ text: '{"age": 30}' }),
    );
    expect(r.passed).toBe(false);
    expect(r.message).toContain('name');
  });

  it('fails for wrong type', async () => {
    const r = await evaluateAssertion(
      { type: 'json-schema', schema: { type: 'array' } },
      makeResult({ text: '{"a": 1}' }),
    );
    expect(r.passed).toBe(false);
  });

  it('fails for invalid JSON', async () => {
    const r = await evaluateAssertion(
      { type: 'json-schema', schema: { type: 'object' } },
      makeResult({ text: 'not json' }),
    );
    expect(r.passed).toBe(false);
    expect(r.message).toContain('not valid JSON');
  });
});

describe('tool-called assertion', () => {
  it('passes when tool was called', async () => {
    const r = await evaluateAssertion(
      { type: 'tool-called', tool: 'write_file' },
      makeResult({ toolCalls: [{ toolName: 'write_file', args: { path: 'a.md' }, result: 'ok' }] }),
    );
    expect(r.passed).toBe(true);
  });

  it('fails when tool was not called', async () => {
    const r = await evaluateAssertion(
      { type: 'tool-called', tool: 'write_file' },
      makeResult({ toolCalls: [{ toolName: 'read_file', args: {}, result: '' }] }),
    );
    expect(r.passed).toBe(false);
    expect(r.message).toContain('read_file');
  });

  it('fails with empty tool calls', async () => {
    const r = await evaluateAssertion(
      { type: 'tool-called', tool: 'write_file' },
      makeResult(),
    );
    expect(r.passed).toBe(false);
    expect(r.message).toContain('(none)');
  });
});

describe('tool-not-called assertion', () => {
  it('passes when tool was not called', async () => {
    const r = await evaluateAssertion(
      { type: 'tool-not-called', tool: 'delete_file' },
      makeResult({ toolCalls: [{ toolName: 'read_file', args: {}, result: '' }] }),
    );
    expect(r.passed).toBe(true);
  });

  it('fails when tool was called', async () => {
    const r = await evaluateAssertion(
      { type: 'tool-not-called', tool: 'delete_file' },
      makeResult({ toolCalls: [{ toolName: 'delete_file', args: {}, result: '' }] }),
    );
    expect(r.passed).toBe(false);
  });
});

describe('tool-args assertion', () => {
  it('passes with matching args (partial match)', async () => {
    const r = await evaluateAssertion(
      { type: 'tool-args', tool: 'write_file', args: { path: 'test.md' } },
      makeResult({
        toolCalls: [{
          toolName: 'write_file',
          args: { path: 'test.md', content: 'hello' },
          result: 'ok',
        }],
      }),
    );
    expect(r.passed).toBe(true);
  });

  it('fails with non-matching args', async () => {
    const r = await evaluateAssertion(
      { type: 'tool-args', tool: 'write_file', args: { path: 'other.md' } },
      makeResult({
        toolCalls: [{ toolName: 'write_file', args: { path: 'test.md' }, result: 'ok' }],
      }),
    );
    expect(r.passed).toBe(false);
  });

  it('fails when tool was not called', async () => {
    const r = await evaluateAssertion(
      { type: 'tool-args', tool: 'write_file', args: { path: 'x' } },
      makeResult(),
    );
    expect(r.passed).toBe(false);
    expect(r.message).toContain('was not called');
  });

  it('deep partial match — nested objects', async () => {
    const r = await evaluateAssertion(
      { type: 'tool-args', tool: 'api_call', args: { config: { timeout: 5000 } } },
      makeResult({
        toolCalls: [{
          toolName: 'api_call',
          args: { config: { timeout: 5000, retries: 3 }, url: 'http://x' },
          result: 'ok',
        }],
      }),
    );
    expect(r.passed).toBe(true);
  });

  it('deep partial match — array values', async () => {
    const r = await evaluateAssertion(
      { type: 'tool-args', tool: 'query', args: { tags: ['a', 'b'] } },
      makeResult({
        toolCalls: [{
          toolName: 'query',
          args: { tags: ['a', 'b'], limit: 10 },
          result: 'ok',
        }],
      }),
    );
    expect(r.passed).toBe(true);
  });

  it('deep partial match fails on different nested value', async () => {
    const r = await evaluateAssertion(
      { type: 'tool-args', tool: 'api_call', args: { config: { timeout: 9999 } } },
      makeResult({
        toolCalls: [{
          toolName: 'api_call',
          args: { config: { timeout: 5000 } },
          result: 'ok',
        }],
      }),
    );
    expect(r.passed).toBe(false);
  });
});

describe('file-exists assertion', () => {
  it('passes when file exists', async () => {
    const store = new InMemoryMemoryStore();
    await store.write('test-agent', 'test.md', 'content');
    const r = await evaluateAssertion(
      { type: 'file-exists', path: 'test.md' },
      makeResult({ store }),
    );
    expect(r.passed).toBe(true);
  });

  it('fails when file does not exist', async () => {
    const r = await evaluateAssertion(
      { type: 'file-exists', path: 'missing.md' },
      makeResult(),
    );
    expect(r.passed).toBe(false);
  });
});

describe('file-contains assertion', () => {
  it('passes when file contains value', async () => {
    const store = new InMemoryMemoryStore();
    await store.write('test-agent', 'test.md', 'Hello Alice');
    const r = await evaluateAssertion(
      { type: 'file-contains', path: 'test.md', value: 'Alice' },
      makeResult({ store }),
    );
    expect(r.passed).toBe(true);
  });

  it('fails when file does not contain value', async () => {
    const store = new InMemoryMemoryStore();
    await store.write('test-agent', 'test.md', 'Hello Bob');
    const r = await evaluateAssertion(
      { type: 'file-contains', path: 'test.md', value: 'Alice' },
      makeResult({ store }),
    );
    expect(r.passed).toBe(false);
  });

  it('fails when file does not exist', async () => {
    const r = await evaluateAssertion(
      { type: 'file-contains', path: 'missing.md', value: 'anything' },
      makeResult(),
    );
    expect(r.passed).toBe(false);
  });
});

describe('max-steps assertion', () => {
  it('passes when within limit', async () => {
    const r = await evaluateAssertion({ type: 'max-steps', max: 5 }, makeResult({ steps: 3 }));
    expect(r.passed).toBe(true);
  });

  it('passes at exact limit', async () => {
    const r = await evaluateAssertion({ type: 'max-steps', max: 3 }, makeResult({ steps: 3 }));
    expect(r.passed).toBe(true);
  });

  it('fails when over limit', async () => {
    const r = await evaluateAssertion({ type: 'max-steps', max: 2 }, makeResult({ steps: 3 }));
    expect(r.passed).toBe(false);
  });
});

describe('max-cost assertion', () => {
  it('passes when within budget', async () => {
    const r = await evaluateAssertion({ type: 'max-cost', maxUsd: 0.01 }, makeResult({ cost: 0.005 }));
    expect(r.passed).toBe(true);
  });

  it('fails when over budget', async () => {
    const r = await evaluateAssertion({ type: 'max-cost', maxUsd: 0.001 }, makeResult({ cost: 0.005 }));
    expect(r.passed).toBe(false);
  });
});

describe('llm-rubric assertion', () => {
  it('fails with no judge model', async () => {
    const r = await evaluateAssertion(
      { type: 'llm-rubric', rubric: 'Should be friendly' },
      makeResult(),
    );
    expect(r.passed).toBe(false);
    expect(r.message).toContain('No judge model');
  });
});

describe('custom assertion', () => {
  it('passes when fn returns true', async () => {
    const r = await evaluateAssertion(
      {
        type: 'custom',
        name: 'custom check',
        fn: (result) => result.text.length > 0,
      },
      makeResult(),
    );
    expect(r.passed).toBe(true);
  });

  it('fails when fn returns false', async () => {
    const r = await evaluateAssertion(
      {
        type: 'custom',
        name: 'empty check',
        fn: (result) => result.text === '',
      },
      makeResult(),
    );
    expect(r.passed).toBe(false);
  });

  it('handles async fn', async () => {
    const r = await evaluateAssertion(
      {
        type: 'custom',
        name: 'async check',
        fn: async (result) => result.steps === 1,
      },
      makeResult(),
    );
    expect(r.passed).toBe(true);
  });

  it('handles fn that throws', async () => {
    const r = await evaluateAssertion(
      {
        type: 'custom',
        name: 'throwing check',
        fn: () => { throw new Error('boom'); },
      },
      makeResult(),
    );
    expect(r.passed).toBe(false);
    expect(r.message).toContain('boom');
  });
});
