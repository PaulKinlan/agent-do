/**
 * Provider resolution for demos.
 *
 * Picks a model provider (Anthropic / Google / OpenAI) based on env:
 *
 *   DEMO_PROVIDER=anthropic | google | openai  (explicit choice)
 *
 * If `DEMO_PROVIDER` is unset, auto-picks the first provider whose API
 * key is available, in order anthropic → google → openai. Fails with a
 * readable error if nothing is set.
 *
 * Per-provider env vars (matches the main CLI's convention — see
 * src/cli/resolve-model.ts):
 *   ANTHROPIC_API_KEY
 *   GOOGLE_GENERATIVE_AI_API_KEY   (canonical)
 *     GOOGLE_API_KEY               (alias, also accepted)
 *     GEMINI_API_KEY               (alias, also accepted)
 *   OPENAI_API_KEY
 *
 * Per-demo model overrides (optional):
 *   DEMO_MASTER_MODEL
 *   DEMO_WORKER_MODEL
 *
 * The SDKs are imported dynamically so only the selected provider is
 * imported and initialised at runtime — the unused providers stay out
 * of the process even though they're present in node_modules.
 */

import type { LanguageModel } from 'ai';

export type Provider = 'anthropic' | 'google' | 'openai';

export interface ResolvedProvider {
  name: Provider;
  model: (id: string) => LanguageModel;
  defaults: { master: string; worker: string };
}

const DEFAULTS: Record<Provider, { master: string; worker: string }> = {
  anthropic: { master: 'claude-sonnet-4-6', worker: 'claude-haiku-4-5' },
  google: { master: 'gemini-2.5-pro', worker: 'gemini-2.5-flash' },
  openai: { master: 'gpt-5', worker: 'gpt-5-mini' },
};

/**
 * Minimum plausible API-key length. The main CLI uses the same floor
 * (src/cli/resolve-model.ts `value.length < 4`) so an obviously empty
 * or placeholder value ("x", "123") produces a clean error instead of
 * a confusing 4xx from the provider.
 */
const MIN_KEY_LENGTH = 4;

function keyFor(name: Provider): string | undefined {
  if (name === 'anthropic') {
    return process.env.ANTHROPIC_API_KEY;
  }
  if (name === 'google') {
    // Accept the canonical name first, then the two common aliases.
    return (
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      process.env.GEMINI_API_KEY
    );
  }
  return process.env.OPENAI_API_KEY;
}

function envHas(name: Provider): boolean {
  const key = keyFor(name);
  return Boolean(key && key.length >= MIN_KEY_LENGTH);
}

export async function resolveProvider(): Promise<ResolvedProvider> {
  const requested = (process.env.DEMO_PROVIDER ?? '').toLowerCase();
  let chosen: Provider | null = null;

  if (requested === 'anthropic' || requested === 'google' || requested === 'openai') {
    if (!envHas(requested)) {
      console.error(
        `Error: DEMO_PROVIDER=${requested} but the corresponding API key is not set (or shorter than ${MIN_KEY_LENGTH} chars).`,
      );
      console.error(missingKeyHint(requested));
      process.exit(1);
    }
    chosen = requested;
  } else if (requested !== '') {
    console.error(`Error: DEMO_PROVIDER="${requested}" is not recognised. Use one of: anthropic, google, openai.`);
    process.exit(1);
  } else {
    for (const candidate of ['anthropic', 'google', 'openai'] as Provider[]) {
      if (envHas(candidate)) {
        chosen = candidate;
        break;
      }
    }
  }

  if (!chosen) {
    console.error('Error: No provider API key found.');
    console.error('  Set one of:');
    console.error('    ANTHROPIC_API_KEY');
    console.error('    GOOGLE_GENERATIVE_AI_API_KEY (or GOOGLE_API_KEY / GEMINI_API_KEY)');
    console.error('    OPENAI_API_KEY');
    console.error('  Optionally set DEMO_PROVIDER=anthropic|google|openai to force a choice.');
    process.exit(1);
  }

  const defaults = {
    master: process.env.DEMO_MASTER_MODEL || DEFAULTS[chosen].master,
    worker: process.env.DEMO_WORKER_MODEL || DEFAULTS[chosen].worker,
  };

  switch (chosen) {
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      const provider = createAnthropic({ apiKey: keyFor('anthropic')! });
      return {
        name: 'anthropic',
        // Cast through unknown because each provider's model type is
        // branded separately; LanguageModel is the unified interface
        // agent-do takes.
        model: (id) => provider(id) as unknown as LanguageModel,
        defaults,
      };
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      const provider = createGoogleGenerativeAI({ apiKey: keyFor('google')! });
      return {
        name: 'google',
        model: (id) => provider(id) as unknown as LanguageModel,
        defaults,
      };
    }
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      const provider = createOpenAI({ apiKey: keyFor('openai')! });
      return {
        name: 'openai',
        model: (id) => provider(id) as unknown as LanguageModel,
        defaults,
      };
    }
  }
}

function missingKeyHint(provider: Provider): string {
  if (provider === 'anthropic') return '  Set ANTHROPIC_API_KEY=sk-ant-...';
  if (provider === 'google') {
    return '  Set GOOGLE_GENERATIVE_AI_API_KEY=... (or GOOGLE_API_KEY / GEMINI_API_KEY).';
  }
  return '  Set OPENAI_API_KEY=sk-...';
}

export function announce(resolved: ResolvedProvider): void {
  // eslint-disable-next-line no-console
  console.log(
    `  Provider: ${resolved.name} (master=${resolved.defaults.master}, worker=${resolved.defaults.worker})`,
  );
}
