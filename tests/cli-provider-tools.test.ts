import { describe, it, expect, vi } from 'vitest';
import {
  buildProviderTools,
  parseProviderOptions,
  hasProviderTools,
  validateCliProviderToolNames,
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

  it('rejects tools that need extra config and points at script mode', async () => {
    // OpenAI `fileSearch` is a real export but needs `vectorStoreIds`,
    // which the CLI can't supply. Reject up front rather than crashing
    // mid-run.
    await expect(
      buildProviderTools('openai', ['fileSearch']),
    ).rejects.toThrow(/requires additional configuration/);
    await expect(
      buildProviderTools('openai', ['fileSearch']),
    ).rejects.toThrow(/script export/);
    // The error should still surface the CLI-safe names so the user
    // can recover without reading the docs.
    await expect(
      buildProviderTools('openai', ['fileSearch']),
    ).rejects.toThrow(/webSearch/);
  });

  it('rejects Google enterpriseWebSearch (needs project config)', async () => {
    await expect(
      buildProviderTools('google', ['enterpriseWebSearch']),
    ).rejects.toThrow(/requires additional configuration/);
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

describe('validateCliProviderToolNames', () => {
  it('is a no-op on an empty list', () => {
    expect(() => validateCliProviderToolNames('ollama', [])).not.toThrow();
  });

  it('rejects providers without a CLI provider-tool surface', () => {
    expect(() =>
      validateCliProviderToolNames('ollama', ['anything']),
    ).toThrow(/Provider "ollama" does not support --provider-tool/);
  });

  it('accepts known aliases for the provider', () => {
    expect(() =>
      validateCliProviderToolNames('anthropic', ['webSearch', 'bash']),
    ).not.toThrow();
  });

  it('accepts CLI-safe canonical names directly', () => {
    expect(() =>
      validateCliProviderToolNames('anthropic', ['webSearch_20250305']),
    ).not.toThrow();
    expect(() =>
      validateCliProviderToolNames('google', ['googleSearch']),
    ).not.toThrow();
  });

  it('rejects names that need extra config', () => {
    expect(() =>
      validateCliProviderToolNames('openai', ['fileSearch']),
    ).toThrow(/not a CLI-safe name/);
  });

  it('rejects unknown names with a recoverable list', () => {
    expect(() =>
      validateCliProviderToolNames('google', ['totallyMadeUp']),
    ).toThrow(/googleSearch/);
  });
});

describe('alias fallback across SDK versions', () => {
  // The resolver in `buildProviderTools` walks the alias's ordered
  // target list and picks the first entry that exists on the
  // installed SDK. `validateCliProviderToolNames` is sync (no SDK
  // import), so the assertions here verify the safe-set / alias
  // contract: every alias target is itself a valid CLI canonical
  // name, so falling back to an older dated variant is always safe.
  it('older dated canonical names are CLI-safe', () => {
    expect(() =>
      validateCliProviderToolNames('anthropic', [
        'webSearch_20250305',
        'codeExecution_20250522',
        'bash_20241022',
      ]),
    ).not.toThrow();
  });

  it('alias names validate without an SDK pre-check', () => {
    expect(() =>
      validateCliProviderToolNames('anthropic', [
        'webSearch',
        'bash',
        'computer',
      ]),
    ).not.toThrow();
  });
});
