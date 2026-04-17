import { describe, it, expect } from 'vitest';
import {
  parseSkillMd,
  buildSkillsPrompt,
  InMemorySkillStore,
  createSkillTools,
} from '../src/skills.js';
import type { Skill } from '../src/types.js';

describe('parseSkillMd', () => {
  it('parses YAML frontmatter', () => {
    const content = `---
name: Web Research
description: Research the web
author: Test Author
version: 1.0.0
---

Use search tools to find information.`;

    const skill = parseSkillMd(content, 'web-research');
    expect(skill.id).toBe('web-research');
    expect(skill.name).toBe('Web Research');
    expect(skill.description).toBe('Research the web');
    expect(skill.author).toBe('Test Author');
    expect(skill.version).toBe('1.0.0');
    expect(skill.content).toBe('Use search tools to find information.');
  });

  it('handles content without frontmatter', () => {
    const content = 'Just plain instructions.';
    const skill = parseSkillMd(content, 'plain');
    expect(skill.id).toBe('plain');
    expect(skill.name).toBe('plain');
    expect(skill.description).toBe('');
    expect(skill.content).toBe('Just plain instructions.');
  });

  it('generates ID from name when no ID provided', () => {
    const content = `---
name: My Cool Skill
description: Does cool things
---

Content here.`;

    const skill = parseSkillMd(content);
    expect(skill.id).toBe('my-cool-skill');
    expect(skill.name).toBe('My Cool Skill');
  });

  it('preserves quoted values that contain colons', () => {
    const content = `---
name: "Helpful: gets things done"
description: "Role: assistant; style: terse"
---

body`;
    const skill = parseSkillMd(content, 'helpful');
    expect(skill.name).toBe('Helpful: gets things done');
    expect(skill.description).toBe('Role: assistant; style: terse');
  });

  it('preserves multiline description via YAML folded/literal blocks', () => {
    const content = `---
name: Multi
description: |
  line one
  line two
---

body`;
    const skill = parseSkillMd(content, 'multi');
    expect(skill.description).toContain('line one');
    expect(skill.description).toContain('line two');
  });

  it('falls back to empty meta on malformed YAML without dropping the body', () => {
    const content = `---
name: "unterminated
---

body goes here`;
    const skill = parseSkillMd(content, 'broken');
    expect(skill.id).toBe('broken');
    expect(skill.content).toBe('body goes here');
  });

  it('keeps valid fields when a single field has the wrong type', () => {
    // YAML parses bare `2` as a number; the old implementation dropped the
    // entire metadata object when that happened. Per-field validation keeps
    // the other fields.
    const content = `---
name: Numbery
description: Has a bad version
version: 2
---

body`;
    const skill = parseSkillMd(content, 'numbery');
    expect(skill.name).toBe('Numbery');
    expect(skill.description).toBe('Has a bad version');
    // 2 coerces to "2" via z.coerce.string — acceptable. The important
    // thing is we didn't lose name / description.
    expect(skill.version).toBe('2');
  });

  it('drops only the oversize field, not sibling fields', () => {
    const big = 'x'.repeat(1000);
    const content = `---
name: Valid
description: ${big}
---

body`;
    const skill = parseSkillMd(content, 'valid');
    expect(skill.name).toBe('Valid');
    // description exceeds 512 cap → dropped, not allowed to nuke `name`.
    expect(skill.description).toBe('');
  });

  it('is case-insensitive for frontmatter keys (Name:, DESCRIPTION:)', () => {
    // The pre-v0.1.4 parser lowercased keys. Restore that so SKILL.md
    // files written with capitalised keys still parse.
    const content = `---
Name: Capitalised
DESCRIPTION: Yelling header
Author: Them
---

body`;
    const skill = parseSkillMd(content, 'cap');
    expect(skill.name).toBe('Capitalised');
    expect(skill.description).toBe('Yelling header');
    expect(skill.author).toBe('Them');
  });

  it('ignores prototype-pollution keys in frontmatter', () => {
    // Not possible to embed `__proto__` via standard YAML keys without
    // quoting, but belt-and-braces: if it does get through, skip it.
    const content = `---
name: Safe
"__proto__":
  polluted: true
---

body`;
    const skill = parseSkillMd(content, 'safe');
    expect(skill.name).toBe('Safe');
    // No prototype side effects:
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('buildSkillsPrompt', () => {
  it('returns empty string for no skills', () => {
    expect(buildSkillsPrompt([])).toBe('');
  });

  it('builds prompt section from skills', () => {
    const skills: Skill[] = [
      {
        id: 'research',
        name: 'Research',
        description: 'Research things',
        content: 'Use search to find info.',
      },
    ];
    const result = buildSkillsPrompt(skills);
    expect(result).toContain('## Installed Skills');
    expect(result).toContain('### Skill: Research');
    expect(result).toContain('Use search to find info.');
  });

  it('includes descriptions', () => {
    const skills: Skill[] = [
      {
        id: 'test',
        name: 'Test Skill',
        description: 'A test skill',
        content: 'Content.',
      },
    ];
    const result = buildSkillsPrompt(skills);
    expect(result).toContain('> A test skill');
  });
});

describe('InMemorySkillStore', () => {
  it('CRUD operations work', async () => {
    const store = new InMemorySkillStore();

    // Initially empty
    expect(await store.list()).toEqual([]);

    // Install
    const skill: Skill = {
      id: 'test',
      name: 'Test',
      description: 'A test skill',
      content: 'Do testing.',
    };
    await store.install(skill);

    // List
    const skills = await store.list();
    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe('test');

    // Get
    const retrieved = await store.get('test');
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe('Test');

    // Get non-existent
    expect(await store.get('nope')).toBeUndefined();

    // Remove
    await store.remove('test');
    expect(await store.list()).toHaveLength(0);
  });

  it('search finds matching skills', async () => {
    const store = new InMemorySkillStore();
    await store.install({
      id: 'web',
      name: 'Web Research',
      description: 'Research the web',
      content: 'Use search tools.',
    });
    await store.install({
      id: 'code',
      name: 'Code Review',
      description: 'Review code',
      content: 'Check for bugs.',
    });

    const results = await store.search('web');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('web');

    const all = await store.search('');
    expect(all).toHaveLength(2);
  });
});

describe('createSkillTools', () => {
  it('returns tool set with expected tools', () => {
    const store = new InMemorySkillStore();
    const tools = createSkillTools(store);

    expect(tools).toHaveProperty('search_skills');
    expect(tools).toHaveProperty('install_skill');
    expect(tools).toHaveProperty('list_skills');
    expect(tools).toHaveProperty('remove_skill');
  });

  it('list_skills execute returns installed skills', async () => {
    const store = new InMemorySkillStore();
    await store.install({
      id: 'test',
      name: 'Test',
      description: 'A test',
      content: 'Content.',
    });

    const tools = createSkillTools(store);
    const result = await tools.list_skills.execute!({} as never, {
      toolCallId: 'test-call',
      messages: [],
    });
    expect(result).toContain('Test');
    expect(result).toContain('test');
  });
});
