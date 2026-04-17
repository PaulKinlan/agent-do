import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveModel } from '../src/cli/resolve-model.js';

const ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENAI_API_KEY',
] as const;

describe('resolveModel — API key preflight', () => {
  const saved: Partial<Record<(typeof ENV_VARS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const v of ENV_VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const v of ENV_VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  it('throws a helpful error naming the env var when ANTHROPIC_API_KEY is missing', async () => {
    await expect(resolveModel('anthropic')).rejects.toThrow(/ANTHROPIC_API_KEY/);
    await expect(resolveModel('anthropic')).rejects.toThrow(/Missing API key/);
  });

  it('throws when GOOGLE_GENERATIVE_AI_API_KEY is missing', async () => {
    await expect(resolveModel('google')).rejects.toThrow(/GOOGLE_GENERATIVE_AI_API_KEY/);
  });

  it('throws when OPENAI_API_KEY is missing', async () => {
    await expect(resolveModel('openai')).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it('does not require an API key for ollama', async () => {
    const model = await resolveModel('ollama');
    expect(model).toBeDefined();
  });

  it('rejects obviously empty keys (< 4 chars) the same as missing', async () => {
    process.env.ANTHROPIC_API_KEY = 'x';
    await expect(resolveModel('anthropic')).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('proceeds when a plausible key is present', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-stub-key';
    const model = await resolveModel('anthropic');
    expect(model).toBeDefined();
  });
});
