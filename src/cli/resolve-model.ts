/**
 * Resolve a LanguageModel from provider name and model ID.
 *
 * Dynamically imports the provider SDK. Users must have the
 * provider package installed and the API key set in env.
 */

import type { LanguageModel } from 'ai';

// Use `Map`s for provider tables so lookups don't touch the prototype chain.
// Indexing a plain object with a user-supplied provider name returns inherited
// values for keys like `constructor`, `toString`, or `__proto__`, which leaks
// into assertApiKey / resolveModel and produces misleading errors.

const DEFAULT_MODELS = new Map<string, string>([
  ['anthropic', 'claude-sonnet-4-6'],
  ['google', 'gemini-2.5-flash'],
  ['openai', 'gpt-4.1-mini'],
  ['ollama', 'llama3.2'],
]);

/**
 * Env var each provider expects. `null` means the provider does not require a key.
 * Absent keys mean the provider is unknown — resolveModel will throw later.
 */
const REQUIRED_ENV = new Map<string, string | null>([
  ['anthropic', 'ANTHROPIC_API_KEY'],
  ['google', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  ['openai', 'OPENAI_API_KEY'],
  ['ollama', null],
]);

const PROVIDER_HINTS = new Map<string, string>([
  ['anthropic', 'https://console.anthropic.com/'],
  ['google', 'https://aistudio.google.com/'],
  ['openai', 'https://platform.openai.com/api-keys'],
]);

function assertApiKey(provider: string): void {
  const envVar = REQUIRED_ENV.get(provider);
  if (envVar === undefined) return; // unknown provider — resolveModel throws later
  if (envVar === null) return; // e.g. ollama, no key required
  const value = process.env[envVar];
  if (!value || value.length < 4) {
    const hint = PROVIDER_HINTS.get(provider);
    throw new Error(
      `Missing API key for provider "${provider}". Set ${envVar} in your environment.` +
      (hint ? `\nGet a key at ${hint}.` : ''),
    );
  }
}

/**
 * Resolve a model from a provider name and optional model ID.
 * Dynamically imports the provider SDK — it must be installed.
 */
export async function resolveModel(
  provider: string,
  modelId?: string,
): Promise<LanguageModel> {
  const id = modelId ?? DEFAULT_MODELS.get(provider);
  if (!id) {
    throw new Error(
      `Unknown provider "${provider}" and no --model specified. ` +
      `Known providers: ${[...DEFAULT_MODELS.keys()].join(', ')}`,
    );
  }

  assertApiKey(provider);

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
        `Unknown provider "${provider}".\n` +
        `The CLI supports: ${[...DEFAULT_MODELS.keys()].join(', ')}.\n` +
        `\n` +
        `For other providers (Mistral, Groq, Cohere, OpenRouter, Bedrock, etc.),\n` +
        `use agent-do as a library and pass any Vercel AI SDK LanguageModel:\n` +
        `\n` +
        `  import { Agent } from 'agent-do';\n` +
        `  import { createMistral } from '@ai-sdk/mistral';\n` +
        `\n` +
        `  const agent = new Agent({ model: createMistral()('mistral-large-latest') });\n` +
        `  await agent.run('your task');\n` +
        `\n` +
        `See: https://sdk.vercel.ai/providers for the full provider list.`,
      );
  }
}

async function tryImport(pkg: string, provider: string): Promise<any> {
  try {
    return await import(pkg);
  } catch {
    throw new Error(
      `Provider "${provider}" needs "${pkg}" installed alongside agent-do.\n` +
      `\n` +
      `  npm install ${pkg}\n` +
      `\n` +
      `If you're running via npx, install agent-do first so providers resolve:\n` +
      `\n` +
      `  npm install -g agent-do ${pkg}\n` +
      `\n` +
      `To use a provider the CLI doesn't support (Mistral, Groq, Cohere, etc.),\n` +
      `import agent-do as a library and pass the Vercel AI SDK model directly.\n` +
      `See: https://sdk.vercel.ai/providers`,
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
