import { describe, it, expect } from 'vitest';
import {
  normaliseToolResult,
  isToolResult,
  type ToolResult,
} from '../src/tools/types.js';

describe('isToolResult', () => {
  it('accepts objects with modelContent + userSummary strings', () => {
    expect(isToolResult({ modelContent: 'a', userSummary: 'b' })).toBe(true);
    expect(isToolResult({ modelContent: 'a', userSummary: 'b', data: { x: 1 } })).toBe(true);
    expect(isToolResult({ modelContent: 'a', userSummary: 'b', blocked: true })).toBe(true);
  });

  it('rejects other shapes', () => {
    expect(isToolResult(null)).toBe(false);
    expect(isToolResult(undefined)).toBe(false);
    expect(isToolResult('')).toBe(false);
    expect(isToolResult(42)).toBe(false);
    expect(isToolResult({})).toBe(false);
    expect(isToolResult({ modelContent: 'a' })).toBe(false);
    expect(isToolResult({ modelContent: 1, userSummary: 'b' })).toBe(false);
  });
});

describe('normaliseToolResult', () => {
  it('passes through a real ToolResult unchanged', () => {
    const tr: ToolResult = { modelContent: 'mc', userSummary: 'us', data: { a: 1 } };
    expect(normaliseToolResult(tr)).toBe(tr);
  });

  it('wraps plain strings into both views', () => {
    const result = normaliseToolResult('Hello');
    expect(result).toEqual({ modelContent: 'Hello', userSummary: 'Hello' });
  });

  it('JSON-stringifies non-string non-ToolResult values', () => {
    const result = normaliseToolResult({ foo: 1, bar: [2, 3] });
    expect(result.modelContent).toBe('{"foo":1,"bar":[2,3]}');
    expect(result.userSummary).toBe('{"foo":1,"bar":[2,3]}');
  });

  it('handles unserialisable values gracefully', () => {
    // A BigInt can't be JSON-stringified — falls back to String().
    const result = normaliseToolResult(BigInt(7));
    expect(result.modelContent).toBe('7');
    expect(result.userSummary).toBe('7');
  });

  it('preserves the blocked flag and data when passed through', () => {
    const tr: ToolResult = {
      modelContent: 'blocked',
      userSummary: 'blocked by rule',
      data: { blocked: true, rule: '.env*' },
      blocked: true,
    };
    const out = normaliseToolResult(tr);
    expect(out.blocked).toBe(true);
    expect(out.data?.rule).toBe('.env*');
  });
});
