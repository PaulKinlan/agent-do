/**
 * Anthropic prompt-cache support.
 *
 * Split out of `src/loop.ts` (agent-do-4os): the core loop no longer carries the
 * provider-specific caching rules, and this module is the single place that knows
 * which models can be cached and where the breakpoints go.
 */

import type { LanguageModel, ModelMessage, JSONValue } from 'ai';

export function isAnthropicModel(model: LanguageModel): boolean {
  if (typeof model === 'string') {
    // Anthropic-minted IDs start with `claude-`; OpenRouter-style IDs start with `anthropic/`.
    // The old substring check flagged ids where "claude" appeared mid-string (e.g.
    // `x-claude-parody` from another vendor); prefix matching avoids that.
    return isAnthropicIdString(model);
  }
  // Vercel AI SDK providers expose a structured string like "anthropic.chat" or "openai.responses".
  // When provider is populated it is authoritative — trust it and ignore modelId even if the
  // modelId contains "claude" (e.g. a non-Anthropic vendor finetune). Only fall back to modelId
  // when the provider field is missing entirely.
  const provider = typeof model.provider === 'string' ? model.provider : undefined;
  if (provider !== undefined) return provider.startsWith('anthropic');
  const modelId = typeof model.modelId === 'string' ? model.modelId : undefined;
  // Share the string-branch rules so OpenRouter-style ids like `anthropic/claude-sonnet-5`
  // still match when an object model exposes them via `modelId` without a provider. Dropping
  // this would silently skip cache headers for valid Anthropic models.
  return modelId !== undefined && isAnthropicIdString(modelId);
}

function isAnthropicIdString(id: string): boolean {
  return id === 'anthropic' || id.startsWith('anthropic/') || id.startsWith('claude-');
}

/**
 * Add cache control breakpoints to messages for Anthropic models.
 * Marks the last message with ephemeral caching so that previous turns
 * are cached across agentic loop steps, reducing cost significantly.
 */
export function addCacheControl(messages: ModelMessage[], model: LanguageModel): ModelMessage[] {
  if (messages.length === 0 || !isAnthropicModel(model)) return messages;

  return messages.map((message, index) => {
    if (index === messages.length - 1) {
      return {
        ...message,
        providerOptions: {
          ...(message as Record<string, unknown>).providerOptions as Record<string, Record<string, JSONValue>> | undefined,
          anthropic: { cacheControl: { type: 'ephemeral' } },
        },
      };
    }
    return message;
  });
}
