import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, interpolate } from '../src/prompts/builder.js';
import { builtinSections } from '../src/prompts/sections.js';
import { builtinTemplates } from '../src/prompts/templates.js';

describe('buildSystemPrompt', () => {
  it('builds from a named template', () => {
    const prompt = buildSystemPrompt({ template: 'assistant' });
    expect(prompt).toContain('# Agent');
    expect(prompt).toContain('Memory Management');
    expect(prompt).toContain('Efficiency');
  });

  it('injects variables into sections', () => {
    const prompt = buildSystemPrompt({
      template: 'assistant',
      variables: { agentName: 'TestBot', description: 'a test agent' },
    });
    expect(prompt).toContain('# TestBot');
    expect(prompt).toContain('a test agent');
  });

  it('allows overriding a section', () => {
    const prompt = buildSystemPrompt({
      template: 'assistant',
      sections: {
        identity: () => '# CustomBot\nI am custom.',
      },
    });
    expect(prompt).toContain('# CustomBot');
    expect(prompt).toContain('I am custom.');
    expect(prompt).not.toContain('# Agent');
  });

  it('allows custom section order without template', () => {
    const prompt = buildSystemPrompt({
      sectionOrder: ['identity', 'efficiency'],
      variables: { agentName: 'MinimalBot' },
    });
    expect(prompt).toContain('# MinimalBot');
    expect(prompt).toContain('Efficiency');
    expect(prompt).not.toContain('Memory Management');
  });

  it('appends extra content', () => {
    const prompt = buildSystemPrompt({
      template: 'assistant',
      append: ['## Extra Rules\nAlways be kind.'],
    });
    expect(prompt).toContain('## Extra Rules');
    expect(prompt).toContain('Always be kind.');
  });

  it('prepends extra content', () => {
    const prompt = buildSystemPrompt({
      template: 'assistant',
      prepend: ['## Preamble\nThis comes first.'],
    });
    const preambleIdx = prompt.indexOf('## Preamble');
    const identityIdx = prompt.indexOf('# Agent');
    expect(preambleIdx).toBeLessThan(identityIdx);
  });

  it('append supports functions', () => {
    const prompt = buildSystemPrompt({
      template: 'assistant',
      append: [(vars) => `Today is ${vars?.date || 'unknown'}.`],
      variables: { date: '2026-04-13' },
    });
    expect(prompt).toContain('Today is 2026-04-13.');
  });

  it('adds custom sections', () => {
    const prompt = buildSystemPrompt({
      sectionOrder: ['identity', 'myCustom'],
      sections: {
        myCustom: () => '## My Custom Section\nDo custom things.',
      },
    });
    expect(prompt).toContain('## My Custom Section');
  });

  it('throws for unknown template name', () => {
    expect(() => buildSystemPrompt({ template: 'nonexistent' })).toThrow('Unknown template');
  });

  it('accepts a custom template object', () => {
    const prompt = buildSystemPrompt({
      template: {
        name: 'custom',
        description: 'A custom template',
        sections: ['identity', 'efficiency'],
      },
      variables: { agentName: 'CustomAgent' },
    });
    expect(prompt).toContain('# CustomAgent');
    expect(prompt).toContain('Efficiency');
  });

  it('sectionOrder overrides template sections', () => {
    const prompt = buildSystemPrompt({
      template: 'assistant',
      sectionOrder: ['identity'], // only identity, skip everything else
    });
    expect(prompt).toContain('# Agent');
    expect(prompt).not.toContain('Memory Management');
  });

  it('runtimeContext section includes variables', () => {
    const prompt = buildSystemPrompt({
      sectionOrder: ['runtimeContext'],
      variables: { date: '2026-04-13', cwd: '/home/user', userName: 'Paul' },
    });
    expect(prompt).toContain('2026-04-13');
    expect(prompt).toContain('/home/user');
    expect(prompt).toContain('Paul');
  });
});

describe('builtinTemplates', () => {
  it('has all expected templates', () => {
    expect(Object.keys(builtinTemplates)).toEqual(
      expect.arrayContaining(['assistant', 'coder', 'researcher', 'reviewer', 'writer', 'planner'])
    );
  });

  it('each template has sections', () => {
    for (const [name, tmpl] of Object.entries(builtinTemplates)) {
      expect(tmpl.sections.length).toBeGreaterThan(0);
      expect(tmpl.name).toBe(name);
    }
  });
});

describe('builtinSections', () => {
  it('has all expected sections', () => {
    const keys = Object.keys(builtinSections);
    expect(keys).toContain('identity');
    expect(keys).toContain('memoryManagement');
    expect(keys).toContain('fileTools');
    expect(keys).toContain('efficiency');
    expect(keys).toContain('concise');
    expect(keys).toContain('selfEditing');
    expect(keys).toContain('learnedPreferences');
  });

  it('each section returns a string', () => {
    for (const fn of Object.values(builtinSections)) {
      const result = fn();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    }
  });
});

describe('interpolate', () => {
  it('replaces variables', () => {
    expect(interpolate('Hello {{name}}!', { name: 'World' })).toBe('Hello World!');
  });

  it('handles multiple variables', () => {
    expect(interpolate('{{a}} and {{b}}', { a: 'X', b: 'Y' })).toBe('X and Y');
  });

  it('preserves unknown variables', () => {
    expect(interpolate('{{known}} {{unknown}}', { known: 'yes' })).toBe('yes {{unknown}}');
  });

  it('handles empty variables', () => {
    expect(interpolate('no vars here', {})).toBe('no vars here');
  });
});
