import { describe, it, expect } from 'vitest';
import { isAnthropicModel } from '../src/loop.js';

describe('isAnthropicModel', () => {
  describe('string inputs', () => {
    it('recognises Anthropic-minted model ids', () => {
      expect(isAnthropicModel('claude-opus-4-7')).toBe(true);
      expect(isAnthropicModel('claude-sonnet-4-6')).toBe(true);
      expect(isAnthropicModel('claude-haiku-4-5')).toBe(true);
    });

    it('recognises OpenRouter-prefixed Anthropic ids', () => {
      expect(isAnthropicModel('anthropic/claude-sonnet-4-6')).toBe(true);
      expect(isAnthropicModel('anthropic')).toBe(true);
    });

    it('rejects ids where "claude" appears only mid-string', () => {
      expect(isAnthropicModel('someone-claude-finetune')).toBe(false);
      expect(isAnthropicModel('x-claude-parody')).toBe(false);
    });

    it('accepts any id that starts with the `claude-` prefix (by intent)', () => {
      expect(isAnthropicModel('claude-parody/v2')).toBe(true);
    });

    it('rejects unrelated models', () => {
      expect(isAnthropicModel('gpt-5.4')).toBe(false);
      expect(isAnthropicModel('gemini-2.5-pro')).toBe(false);
      expect(isAnthropicModel('openai/gpt-5.4')).toBe(false);
    });
  });

  describe('object inputs', () => {
    it('matches by provider prefix', () => {
      expect(isAnthropicModel({ provider: 'anthropic.chat', modelId: 'claude-sonnet-4-6' } as any)).toBe(true);
      expect(isAnthropicModel({ provider: 'anthropic.messages', modelId: 'anything' } as any)).toBe(true);
    });

    it('does not treat a non-Anthropic provider as Anthropic even when the modelId contains "claude"', () => {
      expect(isAnthropicModel({ provider: 'openai.responses', modelId: 'claude-parody' } as any)).toBe(false);
    });

    it('falls back to modelId prefix when provider is missing', () => {
      expect(isAnthropicModel({ modelId: 'claude-opus-4-7' } as any)).toBe(true);
      expect(isAnthropicModel({ modelId: 'something-claude-in-middle' } as any)).toBe(false);
    });

    it('accepts OpenRouter-style modelId (anthropic/<id>) when provider is missing', () => {
      // Regression guard: the old includes('anthropic') check accepted this; the fix
      // must still route it through Anthropic cache headers.
      expect(isAnthropicModel({ modelId: 'anthropic/claude-sonnet-4-6' } as any)).toBe(true);
      expect(isAnthropicModel({ modelId: 'anthropic' } as any)).toBe(true);
    });

    it('returns false when neither provider nor modelId matches', () => {
      expect(isAnthropicModel({ provider: 'openai.chat', modelId: 'gpt-5.4' } as any)).toBe(false);
      expect(isAnthropicModel({} as any)).toBe(false);
    });
  });
});
