import { describe, it, expect } from 'vitest';
import {
  buildProviderTools,
  parseProviderOptions,
  hasProviderTools,
} from '../src/cli/provider-tools.js';

describe('parseProviderOptions', () => {
  it('parses a valid two-level JSON object', () => {
    const result = parseProviderOptions(
      '{"google":{"useSearchGrounding":true}}',
    );
    expect(result).toEqual({
      google: { useSearchGrounding: true },
    });
  });

  it('parses multiple providers in one call', () => {
    const result = parseProviderOptions(
      '{"google":{"a":1},"anthropic":{"b":"x"}}',
    );
    expect(result).toEqual({
      google: { a: 1 },
      anthropic: { b: 'x' },
    });
  });

  it('rejects malformed JSON with a friendly message', () => {
    expect(() => parseProviderOptions('{not json')).toThrow(
      /must be valid JSON/,
    );
  });

  it('rejects non-object top-level values', () => {
    expect(() => parseProviderOptions('null')).toThrow(/JSON object/);
    expect(() => parseProviderOptions('"x"')).toThrow(/JSON object/);
    expect(() => parseProviderOptions('[1,2]')).toThrow(/JSON object/);
  });

  it('rejects non-object inner values', () => {
    expect(() => parseProviderOptions('{"google":42}')).toThrow(
      /provider-options.google/,
    );
    expect(() => parseProviderOptions('{"google":[1]}')).toThrow(
      /provider-options.google/,
    );
  });

  it('strips prototype-pollution keys', () => {
    const result = parseProviderOptions(
      '{"google":{"useSearchGrounding":true,"__proto__":{"polluted":true}}}',
    );
    expect(result.google).toEqual({ useSearchGrounding: true });
    // Object.prototype must remain unmodified.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('hasProviderTools', () => {
  it('reports true for the three first-party providers', () => {
    expect(hasProviderTools('google')).toBe(true);
    expect(hasProviderTools('anthropic')).toBe(true);
    expect(hasProviderTools('openai')).toBe(true);
  });

  it('reports false for unsupported providers', () => {
    expect(hasProviderTools('ollama')).toBe(false);
    expect(hasProviderTools('mistral')).toBe(false);
  });
});

describe('buildProviderTools', () => {
  it('returns an empty tool set for an empty name list', async () => {
    const tools = await buildProviderTools('google', []);
    expect(tools).toEqual({});
  });

  it('throws when the provider has no tool registry', async () => {
    await expect(buildProviderTools('ollama', ['anything'])).rejects.toThrow(
      /not supported for provider "ollama"/,
    );
  });

  it('builds Google `googleSearch` and namespaces the key', async () => {
    const tools = await buildProviderTools('google', ['googleSearch']);
    expect(Object.keys(tools)).toEqual(['google__googleSearch']);
    // The factory returned by `google.tools.googleSearch({})` is a real
    // SDK tool — it has at least a `type` or `description` field. We
    // just check that it exists and is an object.
    expect(tools['google__googleSearch']).toBeDefined();
    expect(typeof tools['google__googleSearch']).toBe('object');
  });

  it('resolves the `webSearch` alias to the dated Anthropic tool', async () => {
    const tools = await buildProviderTools('anthropic', ['webSearch']);
    expect(Object.keys(tools)).toEqual(['anthropic__webSearch_20260209']);
  });

  it('accepts the canonical dated name directly', async () => {
    const tools = await buildProviderTools('anthropic', ['webSearch_20260209']);
    expect(Object.keys(tools)).toEqual(['anthropic__webSearch_20260209']);
  });

  it('rejects unknown tool names with a list of valid ones', async () => {
    await expect(
      buildProviderTools('google', ['totallyMadeUp']),
    ).rejects.toThrow(/Unknown provider tool "totallyMadeUp"/);
    // Error message should include real names so the user can recover.
    await expect(
      buildProviderTools('google', ['totallyMadeUp']),
    ).rejects.toThrow(/googleSearch/);
  });

  it('builds multiple tools in one call', async () => {
    const tools = await buildProviderTools('google', [
      'googleSearch',
      'urlContext',
      'codeExecution',
    ]);
    expect(Object.keys(tools).sort()).toEqual([
      'google__codeExecution',
      'google__googleSearch',
      'google__urlContext',
    ]);
  });
});
