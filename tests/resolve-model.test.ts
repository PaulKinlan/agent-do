import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  it('returns the "Unknown provider" error (not a bogus API-key error) for prototype keys', async () => {
    // Regression guard: plain-object lookups leaked Object.prototype members
    // like `constructor`, `toString`, `__proto__` — producing a misleading
    // "Missing API key" error for `--provider constructor`.
    for (const bogus of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      await expect(resolveModel(bogus)).rejects.toThrow(/Unknown provider/);
    }
  });

  it('treats an unknown provider as unknown without touching env', async () => {
    await expect(resolveModel('unknown-xyz')).rejects.toThrow(/Unknown provider "unknown-xyz"/);
  });
});

// ─── Supply-chain export-shape guard (#40) ─────────────────────────────

describe('resolveModel — missing factory export (#40)', () => {
  // Restore ENV after each test so we don't leak the stub API keys
  // into the preflight-focused suite above.
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-stub-key';
  });
  afterEach(() => {
    if (saved.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.ANTHROPIC_API_KEY;
    vi.resetModules();
    vi.doUnmock('@ai-sdk/anthropic');
  });

  it('throws a clear error when the SDK loads but the factory is missing', async () => {
    // Simulate an installed but incompatible / partially-swapped
    // package: the module resolves, but `createAnthropic` is not a
    // function. The new check catches this before we try to invoke it.
    vi.resetModules();
    vi.doMock('@ai-sdk/anthropic', () => ({
      // Omitting `createAnthropic` — or providing a non-function —
      // is what a tampered-but-shape-lenient replacement might do.
      createAnthropic: 'not-a-function',
    }));
    // Re-import resolveModel so the mocked module is used by its
    // dynamic import path.
    const mod = await import('../src/cli/resolve-model.js');
    await expect(mod.resolveModel('anthropic')).rejects.toThrow(
      /missing the expected export "createAnthropic"/,
    );
  });

  it('error message suggests verifying version, not just reinstall', async () => {
    // Per Copilot's review: "reinstall" is misleading when the root
    // cause is a version mismatch; the message should name the
    // verification step explicitly. Use `undefined` so the destructured
    // import resolves but the typeof check trips.
    vi.resetModules();
    vi.doMock('@ai-sdk/anthropic', () => ({ createAnthropic: undefined }));
    const mod = await import('../src/cli/resolve-model.js');
    await expect(mod.resolveModel('anthropic')).rejects.toThrow(
      /compatible "@ai-sdk\/anthropic" version/,
    );
  });
});
