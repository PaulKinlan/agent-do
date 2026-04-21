/**
 * Tests for template packs (#78):
 *   - manifest parsing + validation
 *   - on-disk loader (bundled packs + fixture packs)
 *   - createTemplatePack composition (system prompt, skills, routines,
 *     variable interpolation, MCP validation)
 *   - install / uninstall / list-packs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  parsePackManifest,
  loadPack,
  loadPackFromDir,
  resolvePackDir,
  createTemplatePack,
  installPack,
  uninstallPack,
  listPacks,
  readInstallRegistry,
  findBundledPacksDir,
} from '../src/packs/index.js';
import { createMockModel } from '../src/testing/index.js';

// ── Fixture helpers ──────────────────────────────────────────────────

function makeFixturePack(
  root: string,
  name: string,
  opts: {
    manifest: Record<string, unknown>;
    skills?: Record<string, string>;
    routines?: Record<string, string>;
    policies?: Record<string, string>;
  },
): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pack.json'), JSON.stringify(opts.manifest, null, 2));
  if (opts.skills) {
    mkdirSync(join(dir, 'skills'), { recursive: true });
    for (const [file, body] of Object.entries(opts.skills)) {
      writeFileSync(join(dir, 'skills', file), body);
    }
  }
  if (opts.routines) {
    mkdirSync(join(dir, 'routines'), { recursive: true });
    for (const [file, body] of Object.entries(opts.routines)) {
      writeFileSync(join(dir, 'routines', file), body);
    }
  }
  if (opts.policies) {
    mkdirSync(join(dir, 'policies'), { recursive: true });
    for (const [file, body] of Object.entries(opts.policies)) {
      writeFileSync(join(dir, 'policies', file), body);
    }
  }
  return dir;
}

let scratchDir: string;
let packsRoot: string;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'agent-do-packs-test-'));
  packsRoot = join(scratchDir, 'packs');
  mkdirSync(packsRoot, { recursive: true });
});

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

// ── parsePackManifest ────────────────────────────────────────────────

describe('parsePackManifest', () => {
  it('parses a minimal valid manifest', () => {
    const m = parsePackManifest(
      JSON.stringify({
        name: 'sample',
        version: '1.0.0',
        description: 'A sample pack',
      }),
    );
    expect(m.name).toBe('sample');
    expect(m.version).toBe('1.0.0');
    expect(m.description).toBe('A sample pack');
  });

  it('rejects invalid names (uppercase, leading dash, spaces)', () => {
    expect(() => parsePackManifest(JSON.stringify({ name: 'Bad Name', version: '1', description: 'x' }))).toThrow();
    expect(() => parsePackManifest(JSON.stringify({ name: '-leading', version: '1', description: 'x' }))).toThrow();
    expect(() => parsePackManifest(JSON.stringify({ name: 'spaces are bad', version: '1', description: 'x' }))).toThrow();
  });

  it('rejects unknown top-level keys', () => {
    expect(() =>
      parsePackManifest(
        JSON.stringify({
          name: 'sample',
          version: '1.0.0',
          description: 'x',
          arbitraryField: true,
        }),
      ),
    ).toThrow();
  });

  it('rejects absolute paths in file references', () => {
    expect(() =>
      parsePackManifest(
        JSON.stringify({
          name: 'sample',
          version: '1',
          description: 'x',
          skills: ['/etc/passwd'],
        }),
      ),
    ).toThrow(/absolute/);
  });

  it('rejects `..` segments in file references', () => {
    expect(() =>
      parsePackManifest(
        JSON.stringify({
          name: 'sample',
          version: '1',
          description: 'x',
          policies: ['../../etc/passwd'],
        }),
      ),
    ).toThrow(/`\.\.`/);
  });

  it('strips prototype-pollution keys at parse time', () => {
    const json = `{
      "name": "sample",
      "version": "1.0.0",
      "description": "x",
      "__proto__": { "polluted": true }
    }`;
    const m = parsePackManifest(json);
    expect(m.name).toBe('sample');
    // Verify Object.prototype wasn't polluted.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('surfaces a clear error on malformed JSON', () => {
    expect(() => parsePackManifest('not json {')).toThrow(/not valid JSON/);
  });
});

// ── loadPack / loader behaviour ─────────────────────────────────────

describe('loadPack', () => {
  it('loads a pack with skills, routines, and policies', async () => {
    makeFixturePack(packsRoot, 'example', {
      manifest: {
        name: 'example',
        version: '1.0.0',
        description: 'Example',
        skills: ['greet'],
        routines: ['hello'],
        policies: ['manners'],
      },
      skills: {
        'greet.md': `---\nname: Greet\ndescription: Say hello\n---\n\nSay hi back.`,
      },
      routines: {
        'hello.md': `---\nname: hello\ndescription: Run a hello\n---\n\nStep 1: say hi.`,
      },
      policies: {
        'manners.md': `Be polite.`,
      },
    });
    const loaded = await loadPack('example', { packsDir: packsRoot });
    expect(loaded.manifest.name).toBe('example');
    expect(loaded.skills.length).toBe(1);
    expect(loaded.skills[0]!.name).toBe('Greet');
    expect(loaded.routines.length).toBe(1);
    expect(loaded.routines[0]!.name).toBe('hello');
    expect(loaded.policies.length).toBe(1);
    expect(loaded.policies[0]!.name).toBe('manners');
  });

  it('throws when a referenced file is missing', async () => {
    makeFixturePack(packsRoot, 'broken', {
      manifest: {
        name: 'broken',
        version: '1.0.0',
        description: 'Broken',
        skills: ['missing'],
      },
    });
    await expect(loadPack('broken', { packsDir: packsRoot })).rejects.toThrow(/skill file/);
  });

  it('throws when the pack directory is missing', async () => {
    await expect(loadPack('nope', { packsDir: packsRoot })).rejects.toThrow(/not found/);
  });

  it('accepts file references with or without .md extension', async () => {
    makeFixturePack(packsRoot, 'ext', {
      manifest: {
        name: 'ext',
        version: '1',
        description: 'Ext',
        skills: ['one', 'two.md'],
      },
      skills: {
        'one.md': '---\nname: One\n---\n\nOne body.',
        'two.md': '---\nname: Two\n---\n\nTwo body.',
      },
    });
    const loaded = await loadPack('ext', { packsDir: packsRoot });
    expect(loaded.skills.map((s) => s.name)).toEqual(['One', 'Two']);
  });

  it('rejects pack names with traversal segments at resolvePackDir', () => {
    expect(resolvePackDir('../escape', { packsDir: packsRoot })).toBeNull();
  });
});

// ── createTemplatePack ───────────────────────────────────────────────

describe('createTemplatePack', () => {
  const mockModel = () => createMockModel({ responses: [{ text: 'ok' }] });

  it('composes system prompt from manifest + policies with variable interpolation', async () => {
    makeFixturePack(packsRoot, 'composed', {
      manifest: {
        name: 'composed',
        version: '1',
        description: 'Composed',
        policies: ['base'],
        variables: [{ name: 'owner', required: true }],
        systemPrompt: "Act as {{owner}}'s assistant.",
      },
      policies: { 'base.md': 'Always serve {{owner}}.' },
    });
    const { systemPrompt, manifest } = await createTemplatePack('composed', {
      model: mockModel(),
      packsDir: packsRoot,
      variables: { owner: 'Alice' },
    });
    expect(manifest.name).toBe('composed');
    expect(systemPrompt).toContain("Act as Alice's assistant.");
    expect(systemPrompt).toContain('Always serve Alice.');
    expect(systemPrompt).toContain('## Policy: base');
  });

  it('interpolates variables into skills and routines', async () => {
    makeFixturePack(packsRoot, 'interp', {
      manifest: {
        name: 'interp',
        version: '1',
        description: 'x',
        skills: ['s'],
        routines: ['r'],
        variables: [{ name: 'topic', default: 'widgets' }],
      },
      skills: { 's.md': `---\nname: S\n---\n\nDescribe {{topic}}.` },
      routines: { 'r.md': `---\nname: r\ndescription: desc\n---\n\nRun on {{topic}}.` },
    });
    const pack = await createTemplatePack('interp', {
      model: mockModel(),
      packsDir: packsRoot,
    });
    expect(pack.skills[0]!.content).toContain('Describe widgets.');
    expect(pack.routines[0]!.body).toContain('Run on widgets.');
  });

  it('caller-supplied variables override manifest defaults', async () => {
    makeFixturePack(packsRoot, 'override', {
      manifest: {
        name: 'override',
        version: '1',
        description: 'x',
        variables: [{ name: 'topic', default: 'widgets' }],
        systemPrompt: 'Focus: {{topic}}.',
      },
    });
    const { systemPrompt } = await createTemplatePack('override', {
      model: mockModel(),
      packsDir: packsRoot,
      variables: { topic: 'sprockets' },
    });
    expect(systemPrompt).toContain('Focus: sprockets.');
  });

  it('throws when a required variable is missing', async () => {
    makeFixturePack(packsRoot, 'required', {
      manifest: {
        name: 'required',
        version: '1',
        description: 'x',
        variables: [{ name: 'owner', required: true }],
      },
    });
    await expect(
      createTemplatePack('required', { model: mockModel(), packsDir: packsRoot }),
    ).rejects.toThrow(/requires variables: owner/);
  });

  it('throws when a required MCP server name is missing from options.mcpServers', async () => {
    makeFixturePack(packsRoot, 'needs-mcp', {
      manifest: {
        name: 'needs-mcp',
        version: '1',
        description: 'x',
        mcpServers: ['gmail', 'calendar'],
      },
    });
    await expect(
      createTemplatePack('needs-mcp', {
        model: mockModel(),
        packsDir: packsRoot,
        mcpServers: {
          gmail: { name: 'gmail', transport: { type: 'stdio', command: 'x' } },
        },
      }),
    ).rejects.toThrow(/requires MCP servers: calendar/);
  });

  it('throws without model', async () => {
    makeFixturePack(packsRoot, 'needs-model', {
      manifest: { name: 'needs-model', version: '1', description: 'x' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(
      createTemplatePack('needs-model', { packsDir: packsRoot } as any),
    ).rejects.toThrow(/requires `options.model`/);
  });

  it('returns an agent with the expected id + name', async () => {
    makeFixturePack(packsRoot, 'ident', {
      manifest: { name: 'ident', version: '1', description: 'x' },
    });
    const { agent } = await createTemplatePack('ident', {
      model: mockModel(),
      packsDir: packsRoot,
    });
    expect(agent.id).toBe('ident');
    expect(agent.name).toBe('Ident');
  });

  it('honours explicit id/name overrides', async () => {
    makeFixturePack(packsRoot, 'ident2', {
      manifest: { name: 'ident2', version: '1', description: 'x' },
    });
    const { agent } = await createTemplatePack('ident2', {
      model: mockModel(),
      packsDir: packsRoot,
      id: 'custom',
      name: 'Custom Agent',
    });
    expect(agent.id).toBe('custom');
    expect(agent.name).toBe('Custom Agent');
  });
});

// ── install / uninstall / list ──────────────────────────────────────

describe('installPack / uninstallPack / listPacks', () => {
  let projectCwd: string;
  let sourceRoot: string;

  beforeEach(() => {
    projectCwd = join(scratchDir, 'project');
    mkdirSync(projectCwd, { recursive: true });
    sourceRoot = join(scratchDir, 'source-packs');
    mkdirSync(sourceRoot, { recursive: true });
  });

  it('installs from --from, records in registry, and listPacks surfaces it', async () => {
    makeFixturePack(sourceRoot, 'installable', {
      manifest: {
        name: 'installable',
        version: '1.2.3',
        description: 'Can be installed',
      },
    });
    const manifest = await installPack('installable', {
      cwd: projectCwd,
      from: join(sourceRoot, 'installable'),
    });
    expect(manifest.name).toBe('installable');
    const destPack = join(projectCwd, '.agent-do', 'packs', 'installable');
    expect(existsSync(join(destPack, 'pack.json'))).toBe(true);

    const registry = await readInstallRegistry(projectCwd);
    expect(registry.installedPacks['installable']).toBeDefined();
    expect(registry.installedPacks['installable']!.version).toBe('1.2.3');

    const entries = await listPacks({ cwd: projectCwd });
    const user = entries.find((e) => e.source === 'user' && e.manifest.name === 'installable');
    expect(user).toBeDefined();
  });

  it('refuses to overwrite without --force', async () => {
    makeFixturePack(sourceRoot, 'installable', {
      manifest: { name: 'installable', version: '1', description: 'x' },
    });
    await installPack('installable', {
      cwd: projectCwd,
      from: join(sourceRoot, 'installable'),
    });
    await expect(
      installPack('installable', { cwd: projectCwd, from: join(sourceRoot, 'installable') }),
    ).rejects.toThrow(/already installed/);
  });

  it('overwrites with --force', async () => {
    makeFixturePack(sourceRoot, 'installable', {
      manifest: { name: 'installable', version: '1', description: 'v1' },
    });
    await installPack('installable', {
      cwd: projectCwd,
      from: join(sourceRoot, 'installable'),
    });
    // Bump the source version and reinstall.
    writeFileSync(
      join(sourceRoot, 'installable', 'pack.json'),
      JSON.stringify({ name: 'installable', version: '2.0.0', description: 'v2' }),
    );
    await installPack('installable', {
      cwd: projectCwd,
      from: join(sourceRoot, 'installable'),
      force: true,
    });
    const registry = await readInstallRegistry(projectCwd);
    expect(registry.installedPacks['installable']!.version).toBe('2.0.0');
  });

  it('uninstall removes the directory and updates the registry', async () => {
    makeFixturePack(sourceRoot, 'installable', {
      manifest: { name: 'installable', version: '1', description: 'x' },
    });
    await installPack('installable', {
      cwd: projectCwd,
      from: join(sourceRoot, 'installable'),
    });
    const removed = await uninstallPack('installable', { cwd: projectCwd });
    expect(removed).toBe(true);
    expect(existsSync(join(projectCwd, '.agent-do', 'packs', 'installable'))).toBe(false);
    const registry = await readInstallRegistry(projectCwd);
    expect(registry.installedPacks['installable']).toBeUndefined();
  });

  it('uninstall of a pack that was never installed returns false', async () => {
    const removed = await uninstallPack('ghost', { cwd: projectCwd });
    expect(removed).toBe(false);
  });

  it('refuses to install when pack.json declares a different name', async () => {
    makeFixturePack(sourceRoot, 'installable', {
      manifest: { name: 'actual-name', version: '1', description: 'x' },
    });
    await expect(
      installPack('installable', { cwd: projectCwd, from: join(sourceRoot, 'installable') }),
    ).rejects.toThrow(/name mismatch/);
  });
});

// ── bundled packs ────────────────────────────────────────────────────

describe('bundled packs', () => {
  it('findBundledPacksDir returns a directory that contains chief-of-staff', () => {
    const dir = findBundledPacksDir();
    expect(dir).not.toBeNull();
    expect(existsSync(join(dir!, 'chief-of-staff', 'pack.json'))).toBe(true);
  });

  it('loadPack loads the bundled chief-of-staff pack with its policies and skills', async () => {
    const loaded = await loadPack('chief-of-staff');
    expect(loaded.manifest.name).toBe('chief-of-staff');
    expect(loaded.policies.length).toBeGreaterThanOrEqual(2);
    expect(loaded.skills.length).toBeGreaterThanOrEqual(3);
    expect(loaded.routines.length).toBeGreaterThanOrEqual(2);
  });

  it('createTemplatePack composes the chief-of-staff pack end-to-end', async () => {
    const pack = await createTemplatePack('chief-of-staff', {
      model: createMockModel({ responses: [{ text: 'ok' }] }),
      variables: { owner: 'Ada Lovelace' },
      workingDir: scratchDir,
    });
    expect(pack.manifest.name).toBe('chief-of-staff');
    expect(pack.systemPrompt).toContain('Ada Lovelace');
    // The skills should be interpolated too — priority-triage references {{owner}}.
    const triage = pack.skills.find((s) => s.id === 'priority-triage');
    expect(triage).toBeDefined();
    expect(triage!.content).toContain('Ada Lovelace');
  });

  it('chief-of-staff refuses to create without the required `owner` variable', async () => {
    await expect(
      createTemplatePack('chief-of-staff', {
        model: createMockModel({ responses: [{ text: 'ok' }] }),
      }),
    ).rejects.toThrow(/owner/);
  });
});
