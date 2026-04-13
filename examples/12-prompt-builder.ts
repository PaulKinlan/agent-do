/**
 * Example 12: System Prompt Builder
 *
 * Build system prompts from composable templates, sections, and variables.
 * Override any section, add custom ones, or create templates from scratch.
 *
 * Run: npx tsx examples/12-prompt-builder.ts
 */

import {
  buildSystemPrompt,
  builtinTemplates,
  builtinSections,
  interpolate,
} from 'agent-do';

console.log('═══════════════════════════════════════════════');
console.log('  Example 12: System Prompt Builder');
console.log('═══════════════════════════════════════════════\n');

// ── 1. Use a built-in template ──
console.log('── 1. Built-in template (assistant) ──');
console.log('   Available templates:', Object.keys(builtinTemplates).join(', '));
console.log('   Available sections:', Object.keys(builtinSections).join(', '));
console.log('');

const basicPrompt = buildSystemPrompt({
  template: 'assistant',
  variables: { agentName: 'Helper' },
});
console.log('   First 200 chars of assistant prompt:');
console.log(`   ${basicPrompt.slice(0, 200).replace(/\n/g, '\n   ')}...\n`);

// ── 2. Customize with variables ──
console.log('── 2. Template with variables ──');
const customPrompt = buildSystemPrompt({
  template: 'coder',
  variables: {
    agentName: 'CodeBot',
    description: 'an expert TypeScript developer',
    date: new Date().toISOString().slice(0, 10),
    cwd: process.cwd(),
  },
});
console.log(`   Prompt starts with: ${customPrompt.slice(0, 100)}...`);
console.log(`   Total length: ${customPrompt.length} chars\n`);

// ── 3. Override a section ──
console.log('── 3. Override a section ──');
const overriddenPrompt = buildSystemPrompt({
  template: 'assistant',
  sections: {
    identity: (vars) => `# ${vars?.agentName || 'Bot'}\n\nYou are a pirate assistant. Arrr!`,
  },
  variables: { agentName: 'PirateBot' },
});
console.log(`   Identity section: ${overriddenPrompt.split('\n').slice(0, 3).join(' | ')}\n`);

// ── 4. Custom sections ──
console.log('── 4. Add custom sections ──');
const customSectionsPrompt = buildSystemPrompt({
  sectionOrder: ['identity', 'myRules', 'efficiency', 'learnedPreferences'],
  sections: {
    myRules: () => `## My Rules\n\n- Always respond in haiku\n- Never use the word "the"\n- End every message with a tree emoji`,
  },
  variables: { agentName: 'HaikuBot', description: 'a haiku-writing assistant' },
});
console.log('   Custom prompt sections:');
customSectionsPrompt.split('##').forEach(s => {
  if (s.trim()) console.log(`     ## ${s.trim().split('\n')[0]}`);
});
console.log('');

// ── 5. Append content (soul.md pattern) ──
console.log('── 5. Append extra content (soul.md pattern) ──');
const soulContent = `## Soul

You are warm but direct. You care about getting things right.
You never apologize unnecessarily. You admit when you don't know something.`;

const soulPrompt = buildSystemPrompt({
  template: 'assistant',
  append: [soulContent],
  variables: { agentName: 'SoulfulBot' },
});
console.log(`   Prompt ends with: ...${soulPrompt.slice(-100).replace(/\n/g, '\n   ')}\n`);

// ── 6. Variable interpolation ──
console.log('── 6. Variable interpolation ──');
const template = 'Hello {{name}}, today is {{date}}. You work at {{company}}.';
const result = interpolate(template, {
  name: 'Paul',
  date: '2026-04-13',
  company: 'Google',
});
console.log(`   Template: ${template}`);
console.log(`   Result:   ${result}\n`);

// ── 7. Build a fully custom template ──
console.log('── 7. Custom template object ──');
const myTemplate = {
  name: 'data-analyst',
  description: 'A data analysis specialist',
  sections: ['identity', 'dataAnalysis', 'efficiency', 'concise'],
};

const dataPrompt = buildSystemPrompt({
  template: myTemplate,
  sections: {
    dataAnalysis: () => `## Data Analysis

When analyzing data:
1. Understand the data structure and types
2. Look for patterns, outliers, and trends
3. Present findings with charts when possible
4. Always show your work and methodology`,
  },
  variables: { agentName: 'DataBot', description: 'a data analysis expert' },
});
console.log(`   Custom template "${myTemplate.name}" generated ${dataPrompt.length} chars`);
console.log(`   Sections: ${myTemplate.sections.join(' → ')}\n`);

console.log('✓ Done — prompts are fully composable and configurable.');
