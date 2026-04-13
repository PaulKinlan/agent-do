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

  it('treats empty string as a valid value (not missing)', () => {
    expect(interpolate('value={{key}}', { key: '' })).toBe('value=');
  });

  it('handles {{#if}} conditional blocks', () => {
    const tmpl = '{{#if name}}Hello {{name}}!{{/if}}';
    expect(interpolate(tmpl, { name: 'Paul' })).toBe('Hello Paul!');
    expect(interpolate(tmpl, {})).toBe('');
  });

  it('handles {{#if}} with empty value (treated as falsy)', () => {
    expect(interpolate('{{#if x}}yes{{/if}}', { x: '' })).toBe('');
  });

  it('handles multiple {{#if}} blocks', () => {
    const tmpl = '{{#if a}}A{{/if}} {{#if b}}B{{/if}}';
    expect(interpolate(tmpl, { a: 'yes', b: 'yes' })).toBe('A B');
    expect(interpolate(tmpl, { a: 'yes' })).toBe('A ');
  });
});

describe('buildSystemPrompt edge cases', () => {
  it('onUnknownSection throw mode', () => {
    expect(() => buildSystemPrompt({
      sectionOrder: ['nonexistent'],
      onUnknownSection: 'throw',
    })).toThrow('Unknown section');
  });

  it('onUnknownSection callback mode', () => {
    const unknown: string[] = [];
    buildSystemPrompt({
      sectionOrder: ['identity', 'nope', 'also_nope'],
      onUnknownSection: (key) => unknown.push(key),
    });
    expect(unknown).toEqual(['nope', 'also_nope']);
  });

  it('onUnknownSection skip mode (default) does not throw', () => {
    expect(() => buildSystemPrompt({
      sectionOrder: ['identity', 'nonexistent'],
    })).not.toThrow();
  });

  it('fileTools section lists edit_file', () => {
    const result = builtinSections.fileTools();
    expect(result).toContain('edit_file');
    expect(result).toContain('read_file');
    expect(result).toContain('write_file');
  });

  it('prototype method names work as section keys (null-prototype map)', () => {
    // Keys like 'toString', 'hasOwnProperty' would shadow Object.prototype
    // on a normal {}, but Object.create(null) handles them safely
    const prompt = buildSystemPrompt({
      sectionOrder: ['toString', 'hasOwnProperty'],
      sections: {
        'toString': () => 'toString section',
        'hasOwnProperty': () => 'hasOwn section',
      },
    });
    expect(prompt).toContain('toString section');
    expect(prompt).toContain('hasOwn section');
  });

  it('constructor key is handled safely', () => {
    const prompt = buildSystemPrompt({
      sectionOrder: ['constructor'],
      sections: {
        'constructor': () => 'constructor section',
      },
    });
    expect(prompt).toContain('constructor section');
  });

  it('empty sectionOrder produces prompt from prepend/append only', () => {
    const prompt = buildSystemPrompt({
      sectionOrder: [],
      prepend: ['before'],
      append: ['after'],
    });
    expect(prompt).toBe('before\n\nafter');
  });

  it('all builtin templates produce non-empty prompts', () => {
    for (const name of Object.keys(builtinTemplates)) {
      const prompt = buildSystemPrompt({ template: name });
      expect(prompt.length).toBeGreaterThan(100);
    }
  });
});

describe('interpolate advanced', () => {
  it('{{#if}} with nested variable replacement', () => {
    const tmpl = '{{#if name}}Hello {{name}}, welcome!{{/if}}';
    expect(interpolate(tmpl, { name: 'Paul' })).toBe('Hello Paul, welcome!');
  });

  it('{{#if}} preserves content outside blocks', () => {
    const tmpl = 'Start. {{#if show}}Middle.{{/if}} End.';
    expect(interpolate(tmpl, { show: 'yes' })).toBe('Start. Middle. End.');
    expect(interpolate(tmpl, {})).toBe('Start.  End.');
  });

  it('handles multiline {{#if}} blocks', () => {
    const tmpl = '{{#if bio}}Bio:\n{{bio}}\nEnd bio.{{/if}}';
    expect(interpolate(tmpl, { bio: 'I am a developer.' })).toBe('Bio:\nI am a developer.\nEnd bio.');
    expect(interpolate(tmpl, {})).toBe('');
  });

  it('multiple variables in one line', () => {
    expect(interpolate('{{a}}-{{b}}-{{c}}', { a: '1', b: '2', c: '3' })).toBe('1-2-3');
  });

  it('same variable used multiple times', () => {
    expect(interpolate('{{x}} and {{x}} again', { x: 'hi' })).toBe('hi and hi again');
  });
});

describe('interpolate defensive — null/undefined/edge cases', () => {
  it('handles null variables without throwing', () => {
    expect(interpolate('Hello {{name}}!', null)).toBe('Hello {{name}}!');
  });

  it('handles undefined variables without throwing', () => {
    expect(interpolate('Hello {{name}}!', undefined)).toBe('Hello {{name}}!');
  });

  it('handles null variables with {{#if}} blocks', () => {
    const tmpl = '{{#if name}}Hello {{name}}!{{/if}} Done.';
    expect(interpolate(tmpl, null)).toBe(' Done.');
  });

  it('handles undefined variables with {{#if}} blocks', () => {
    const tmpl = '{{#if name}}Hello {{name}}!{{/if}} Done.';
    expect(interpolate(tmpl, undefined)).toBe(' Done.');
  });

  it('handles empty template string', () => {
    expect(interpolate('', { name: 'Paul' })).toBe('');
    expect(interpolate('', null)).toBe('');
    expect(interpolate('', {})).toBe('');
  });

  it('handles template with no placeholders', () => {
    expect(interpolate('plain text', { name: 'Paul' })).toBe('plain text');
    expect(interpolate('plain text', null)).toBe('plain text');
  });

  it('handles variable value containing curly braces', () => {
    expect(interpolate('{{x}}', { x: '{{y}}' })).toBe('{{y}}');
  });

  it('handles variable value containing regex special chars', () => {
    expect(interpolate('{{x}}', { x: 'a.*b+c?(d)' })).toBe('a.*b+c?(d)');
  });

  it('preserves partial/malformed placeholders', () => {
    expect(interpolate('{{', {})).toBe('{{');
    expect(interpolate('}}', {})).toBe('}}');
    expect(interpolate('{name}', { name: 'Paul' })).toBe('{name}');
    expect(interpolate('{{ name }}', { name: 'Paul' })).toBe('{{ name }}');
  });

  it('handles prototype property names as keys safely', () => {
    expect(interpolate('{{toString}}', { toString: 'safe' })).toBe('safe');
    expect(interpolate('{{constructor}}', { constructor: 'safe' })).toBe('safe');
    expect(interpolate('{{hasOwnProperty}}', { hasOwnProperty: 'safe' })).toBe('safe');
  });

  it('does not resolve prototype methods when key is absent', () => {
    // toString exists on Object.prototype — should NOT resolve it
    expect(interpolate('{{toString}}', {})).toBe('{{toString}}');
    expect(interpolate('{{constructor}}', {})).toBe('{{constructor}}');
  });

  it('{{#if}} with prototype property names', () => {
    expect(interpolate('{{#if toString}}yes{{/if}}', { toString: 'val' })).toBe('yes');
    expect(interpolate('{{#if toString}}yes{{/if}}', {})).toBe('');
  });

  it('handles adjacent placeholders', () => {
    expect(interpolate('{{a}}{{b}}', { a: 'x', b: 'y' })).toBe('xy');
  });

  it('handles variable with newlines in value', () => {
    expect(interpolate('{{x}}', { x: 'line1\nline2' })).toBe('line1\nline2');
  });

  it('handles nested {{#if}} blocks (inner not supported — treated as literals)', () => {
    // The regex is non-greedy, so nested blocks won't work as expected.
    // This test documents the behavior — inner {{/if}} closes the outer block.
    const tmpl = '{{#if a}}outer {{#if b}}inner{{/if}} rest{{/if}}';
    // The first {{/if}} closes the outer block
    const result = interpolate(tmpl, { a: 'yes', b: 'yes' });
    expect(result).toContain('outer');
  });

  it('handles {{#if}} with only whitespace key', () => {
    // \w+ won't match spaces, so this should pass through unchanged
    expect(interpolate('{{#if }}text{{/if}}', {})).toBe('{{#if }}text{{/if}}');
  });
});

describe('buildSystemPrompt defensive', () => {
  it('works with no options at all', () => {
    const prompt = buildSystemPrompt();
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('works with empty options object', () => {
    const prompt = buildSystemPrompt({});
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('handles variables as undefined', () => {
    const prompt = buildSystemPrompt({
      template: 'assistant',
      variables: undefined,
    });
    expect(prompt).toContain('# Agent');
  });

  it('handles empty append and prepend arrays', () => {
    const prompt = buildSystemPrompt({
      template: 'assistant',
      append: [],
      prepend: [],
    });
    expect(prompt).toContain('# Agent');
  });

  it('handles sections that return empty strings', () => {
    const prompt = buildSystemPrompt({
      sectionOrder: ['empty', 'identity'],
      sections: { empty: () => '' },
    });
    expect(prompt).toContain('# Agent');
  });

  it('section functions receive undefined vars when no variables provided', () => {
    let receivedVars: unknown = 'sentinel';
    buildSystemPrompt({
      sectionOrder: ['test'],
      sections: {
        test: (vars) => {
          receivedVars = vars;
          return 'ok';
        },
      },
    });
    expect(receivedVars).toBeUndefined();
  });

  it('section functions receive variables when provided', () => {
    let receivedVars: unknown;
    buildSystemPrompt({
      sectionOrder: ['test'],
      sections: {
        test: (vars) => {
          receivedVars = vars;
          return 'ok';
        },
      },
      variables: { key: 'val' },
    });
    expect(receivedVars).toEqual({ key: 'val' });
  });

  it('append function receives undefined vars when no variables', () => {
    let receivedVars: unknown = 'sentinel';
    buildSystemPrompt({
      sectionOrder: [],
      append: [(vars) => {
        receivedVars = vars;
        return 'appended';
      }],
    });
    expect(receivedVars).toBeUndefined();
  });

  it('duplicate section keys in order — renders section twice', () => {
    const prompt = buildSystemPrompt({
      sectionOrder: ['identity', 'identity'],
      variables: { agentName: 'DupeBot' },
    });
    const matches = prompt.match(/# DupeBot/g);
    expect(matches?.length).toBe(2);
  });

  it('custom template object with empty sections array', () => {
    const prompt = buildSystemPrompt({
      template: { name: 'empty', description: 'nothing', sections: [] },
    });
    expect(prompt).toBe('');
  });
});
