import { describe, it, expect } from 'vitest';
import {
  redactToolOutputBlocksInString,
  redactToolOutputBlocks,
  stripStaleToolOutputs,
  cutoffForKeepWindow,
} from '../src/loop-history.js';
import type { ModelMessage } from 'ai';

describe('redactToolOutputBlocksInString', () => {
  it('replaces a single block with a self-closing marker preserving attributes', () => {
    const input = '<tool_output tool="read_file" path="src/app.ts">\nconst x = 1;\n</tool_output>';
    const out = redactToolOutputBlocksInString(input);
    expect(out).toBe('<tool_output tool="read_file" path="src/app.ts" redacted="stale"/>');
  });

  it('redacts multiple blocks in the same string', () => {
    const input = [
      'before',
      '<tool_output tool="read_file" path="a.md">A</tool_output>',
      'middle',
      '<tool_output tool="grep_file" path=".">B</tool_output>',
      'after',
    ].join('\n');
    const out = redactToolOutputBlocksInString(input);
    expect(out).toContain('redacted="stale"');
    expect(out).not.toContain('A</tool_output>');
    expect(out).not.toContain('B</tool_output>');
    expect(out).toContain('before');
    expect(out).toContain('middle');
    expect(out).toContain('after');
  });

  it('is idempotent on already-redacted markers', () => {
    const stale = '<tool_output tool="read_file" path="x" redacted="stale"/>';
    expect(redactToolOutputBlocksInString(stale)).toBe(stale);
  });

  it('leaves unrelated text alone', () => {
    const text = 'plain prose with <strong>html-ish</strong> tags';
    expect(redactToolOutputBlocksInString(text)).toBe(text);
  });

  it('handles bodies that span newlines, including nested-looking content', () => {
    const input = `<tool_output tool="t" path="p">
line one
<inner>not a tool block</inner>
line three
</tool_output>`;
    const out = redactToolOutputBlocksInString(input);
    expect(out).toContain('redacted="stale"');
    expect(out).not.toContain('line one');
    expect(out).not.toContain('inner');
  });
});

describe('redactToolOutputBlocks (recursive)', () => {
  it('walks into nested arrays and objects', () => {
    const input = {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: '1',
          output: '<tool_output tool="x" path="p">leak</tool_output>',
        },
      ],
    };
    const out = redactToolOutputBlocks(input) as typeof input;
    const text = JSON.stringify(out);
    expect(text).not.toContain('leak');
    expect(text).toContain('redacted=\\"stale\\"');
  });

  it('returns primitives unchanged', () => {
    expect(redactToolOutputBlocks(42)).toBe(42);
    expect(redactToolOutputBlocks(null)).toBe(null);
    expect(redactToolOutputBlocks(undefined)).toBe(undefined);
    expect(redactToolOutputBlocks(true)).toBe(true);
  });

  it('preserves non-tool string contents', () => {
    expect(redactToolOutputBlocks('hello')).toBe('hello');
  });
});

describe('cutoffForKeepWindow', () => {
  it('returns 0 when there are fewer iterations than the window', () => {
    expect(cutoffForKeepWindow([0], 1)).toBe(0);
    expect(cutoffForKeepWindow([0, 5], 5)).toBe(0);
  });

  it('returns the start of the (Nth-from-end) iteration', () => {
    const starts = [0, 5, 11, 18];
    expect(cutoffForKeepWindow(starts, 1)).toBe(18); // keep iter 3 → cut everything before 18
    expect(cutoffForKeepWindow(starts, 2)).toBe(11);
    expect(cutoffForKeepWindow(starts, 3)).toBe(5);
  });

  it('Infinity disables redaction (cutoff = 0)', () => {
    expect(cutoffForKeepWindow([0, 5, 11, 18], Infinity)).toBe(0);
  });

  it('non-positive keepWindow redacts everything before the most recent iteration', () => {
    const starts = [0, 5, 11];
    expect(cutoffForKeepWindow(starts, 0)).toBe(11);
    expect(cutoffForKeepWindow(starts, -3)).toBe(11);
  });
});

describe('stripStaleToolOutputs', () => {
  // Helper to make a fake tool-result message in the AI SDK's shape.
  const toolMsg = (body: string): ModelMessage => ({
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 't',
        toolName: 'read_file',
        // The AI SDK v6 shape varies; passing `output` as a string keeps
        // the test independent of the runtime version (the recursive
        // walker handles either shape).
        output: { type: 'text', value: `<tool_output tool="read_file" path="x">${body}</tool_output>` },
      },
    ],
  } as unknown as ModelMessage);

  it('redacts only messages older than the cutoff', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'do it' },
      toolMsg('SECRET-OLD'),
      { role: 'assistant', content: [{ type: 'text', text: 'hmm' }] } as unknown as ModelMessage,
      toolMsg('SECRET-NEW'),
    ];

    // keepFromIndex = 3 → redact indices 0..2 → only SECRET-OLD touched.
    const rewritten = stripStaleToolOutputs(messages, 3);
    expect(rewritten).toBe(1);
    // JSON.stringify escapes inner quotes, so look for the escaped form.
    expect(JSON.stringify(messages[1])).not.toContain('SECRET-OLD');
    expect(JSON.stringify(messages[1])).toContain('redacted=\\"stale\\"');
    expect(JSON.stringify(messages[3])).toContain('SECRET-NEW');
  });

  it('keepFromIndex = 0 is a no-op', () => {
    const messages: ModelMessage[] = [toolMsg('STILL-HERE')];
    const rewritten = stripStaleToolOutputs(messages, 0);
    expect(rewritten).toBe(0);
    expect(JSON.stringify(messages[0])).toContain('STILL-HERE');
  });

  it('does not touch user/assistant/system messages', () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: '<tool_output>fake-in-system</tool_output>' } as unknown as ModelMessage,
      { role: 'user', content: '<tool_output>fake-in-user</tool_output>' } as unknown as ModelMessage,
      { role: 'assistant', content: '<tool_output>fake-in-assistant</tool_output>' } as unknown as ModelMessage,
    ];
    stripStaleToolOutputs(messages, 3);
    expect(JSON.stringify(messages)).toContain('fake-in-system');
    expect(JSON.stringify(messages)).toContain('fake-in-user');
    expect(JSON.stringify(messages)).toContain('fake-in-assistant');
  });

  it('is idempotent — running twice yields the same shape', () => {
    const messages: ModelMessage[] = [toolMsg('OLD'), toolMsg('NEW')];
    stripStaleToolOutputs(messages, 1);
    const after1 = JSON.stringify(messages);
    stripStaleToolOutputs(messages, 1);
    const after2 = JSON.stringify(messages);
    expect(after2).toBe(after1);
  });
});
