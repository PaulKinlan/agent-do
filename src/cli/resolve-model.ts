/**
 * Resolve a LanguageModel from provider name and model ID.
 *
 * Dynamically imports the provider SDK. Users must have the
 * provider package installed and the API key set in env.
 */

import type { LanguageModel } from 'ai';

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  google: 'gemini-2.5-flash',
  openai: 'gpt-4.1-mini',
  ollama: 'llama3.2',
};

/**
 * Resolve a model from a provider name and optional model ID.
 * Dynamically imports the provider SDK — it must be installed.
 */
export async function resolveModel(
  provider: string,
  modelId?: string,
): Promise<LanguageModel> {
  const id = modelId ?? DEFAULT_MODELS[provider];
  if (!id) {
    throw new Error(
      `Unknown provider "${provider}" and no --model specified. ` +
      `Known providers: ${Object.keys(DEFAULT_MODELS).join(', ')}`,
    );
  }

  switch (provider) {
    case 'anthropic': {
      const { createAnthropic } = await tryImport('@ai-sdk/anthropic', provider);
      return createAnthropic()(id) as LanguageModel;
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await tryImport('@ai-sdk/google', provider);
      return createGoogleGenerativeAI()(id) as LanguageModel;
    }
    case 'openai': {
      const { createOpenAI } = await tryImport('@ai-sdk/openai', provider);
      return createOpenAI()(id) as LanguageModel;
    }
    case 'ollama': {
      // Use OpenAI-compatible endpoint for Ollama (consistent with examples)
      const { createOpenAI } = await tryImport('@ai-sdk/openai', 'ollama (via @ai-sdk/openai)');
      return createOpenAI({
        baseURL: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1',
        apiKey: 'ollama',
      })(id) as LanguageModel;
    }
    default:
      throw new Error(
        `Unknown provider "${provider}". ` +
        `Available: ${Object.keys(DEFAULT_MODELS).join(', ')}`,
      );
  }
}

async function tryImport(pkg: string, provider: string): Promise<any> {
  try {
    return await import(pkg);
  } catch {
    throw new Error(
      `Provider "${provider}" requires "${pkg}" to be installed.\n` +
      `Run: npm install ${pkg}`,
    );
  }
}

/**
 * Resolve models for comparison across multiple providers.
 */
export async function resolveCompareProviders(
  providerNames: string[],
  modelId?: string,
): Promise<Array<{ name: string; model: LanguageModel }>> {
  const results = [];
  for (const name of providerNames) {
    const model = await resolveModel(name, modelId);
    results.push({ name, model });
  }
  return results;
}
