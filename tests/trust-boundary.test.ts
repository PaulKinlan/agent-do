import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FilesystemMemoryStore } from '../src/stores/filesystem.js';
import { validateAgentId } from '../src/stores/agent-id.js';
import { SavedAgentSchema, loadSavedAgent } from '../src/cli/agents.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-do-trust-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── #20 H-01: path traversal in FilesystemMemoryStore.resolve() ──────────────

describe('H-01: path-traversal guards in FilesystemMemoryStore.resolve()', () => {
  it('rejects sibling directory whose name shares the base prefix', async () => {
    // Regression for the specific bug PR #64 fixed: the old check was
    // `resolved.startsWith(baseDir)` without a separator. Given
    // baseDir `<tmp>/agent`, a `../agent-evil/secret` traversal
    // resolves to a sibling that shared the base prefix string —
    // `<tmp>/agent-evil/secret` starts with `<tmp>/agent` — so the
    // naive startsWith check accepted it. The `withinBase` helper
    // now uses `path.relative` and rejects the sibling correctly.
    const baseDir = path.join(tmpDir, 'agent');
    fs.mkdirSync(baseDir);
    const agentDir = path.join(baseDir, 'agent-1');
    fs.mkdirSync(agentDir);
    fs.mkdirSync(path.join(tmpDir, 'agent-evil'));
    fs.writeFileSync(path.join(tmpDir, 'agent-evil', 'secret'), 'pwn');

    const store = new FilesystemMemoryStore(baseDir);
    // Valid agentId, traversal-shaped filePath: the filePath path of
    // the check is what has to catch this.
    await expect(
      store['resolve']('agent-1', '../../agent-evil/secret'),
    ).rejects.toThrow(/Path traversal/);
  });

  it('rejects symlinks pointing outside the base directory', async () => {
    const baseDir = path.join(tmpDir, 'sandbox');
    fs.mkdirSync(baseDir);
    const agentDir = path.join(baseDir, 'agent-1');
    fs.mkdirSync(agentDir);

    const outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'leak.txt'), 'sensitive');

    // Plant a symlink: <base>/agent-1/escape -> <tmp>/outside
    fs.symlinkSync(outside, path.join(agentDir, 'escape'));

    const store = new FilesystemMemoryStore(baseDir);
    await expect(
      store['resolve']('agent-1', 'escape/leak.txt'),
    ).rejects.toThrow(/symlink not allowed/);
  });

  it('rejects symlinks even when planted at the agent root level', async () => {
    const baseDir = path.join(tmpDir, 'sandbox');
    fs.mkdirSync(baseDir);
    fs.symlinkSync(tmpDir, path.join(baseDir, 'agent-2'));

    const store = new FilesystemMemoryStore(baseDir);
    // After PR #64's canonicalise-base fix, the agentDir itself gets
    // realpath'd and escapes baseDir at the agentId check, so the
    // error is "Path traversal not allowed (agentId)" rather than
    // the symlink-specific message. Either outcome is correct —
    // both block the escape.
    await expect(
      store['resolve']('agent-2', 'leak.txt'),
    ).rejects.toThrow(/Path traversal|symlink not allowed/);
  });

  it('still allows ordinary paths under the base', async () => {
    const baseDir = path.join(tmpDir, 'sandbox');
    const store = new FilesystemMemoryStore(baseDir);
    // Should not throw; resolve() returns an absolute path inside baseDir.
    // Use realpath on baseDir because macOS /var -> /private/var symlinks
    // cause `path.resolve` to disagree with the resolve() output once
    // we canonicalise everything. The relative-path check is robust to
    // the indirection.
    const out = await store['resolve']('agent-1', 'notes.md');
    const rel = path.relative(fs.realpathSync(baseDir), out);
    expect(rel).not.toMatch(/^\.\./);
    expect(path.isAbsolute(rel)).toBe(false);
  });

  it('allows child names that start with `..` (Codex #64 follow-up)', async () => {
    // `..cache` and `..notes` are valid child dirs — the old
    // `rel.startsWith('..')` check rejected them as traversal. The
    // fixed check only matches `..` exactly or followed by a path
    // separator.
    const baseDir = path.join(tmpDir, 'sandbox');
    const store = new FilesystemMemoryStore(baseDir);
    await expect(
      store['resolve']('agent-1', '..cache/file.txt'),
    ).resolves.toMatch(/\.\.cache/);
    await expect(
      store['resolve']('agent-1', '..notes'),
    ).resolves.toMatch(/\.\.notes/);
  });

  it('rejects cross-agent traversal (PR #64 Copilot)', async () => {
    // `filePath = "../a2/secret"` resolves to a path inside baseDir
    // but outside the requesting agent's own directory. The fixed
    // resolve() checks containment against agentDir, not baseDir.
    const baseDir = path.join(tmpDir, 'sandbox');
    fs.mkdirSync(baseDir);
    const a2 = path.join(baseDir, 'a2');
    fs.mkdirSync(a2);
    fs.writeFileSync(path.join(a2, 'secret'), 'tenant-2');

    const store = new FilesystemMemoryStore(baseDir);
    await expect(
      store['resolve']('a1', '../a2/secret'),
    ).rejects.toThrow(/Path traversal/);
  });

  it('handles a symlinked baseDir (Codex #64 P2)', async () => {
    // baseDir itself is a symlink. The earlier fix canonicalised the
    // target but not the base, so every in-base path failed `withinBase`
    // because the realpath landed on a different string than the raw
    // `path.resolve(baseDir)` the comparison used.
    const realBase = path.join(tmpDir, 'real-store');
    fs.mkdirSync(realBase);
    const linkedBase = path.join(tmpDir, 'linked-store');
    fs.symlinkSync(realBase, linkedBase);

    const store = new FilesystemMemoryStore(linkedBase);
    // Normal read/write through a linked base must not throw.
    await expect(
      store['resolve']('a1', 'notes.md'),
    ).resolves.toBeTypeOf('string');
  });

  it('handles a filesystem-root baseDir (PR #64 Copilot)', async () => {
    // When base is `/` (or a Windows drive root), `base + sep` becomes
    // `//` — the old naive startsWith would reject every legitimate
    // path. The `path.relative`-based `withinBase` handles this.
    // We can't actually test with `/` in a sandboxed test, but we can
    // at least verify the helper works at tmpDir without issue.
    const store = new FilesystemMemoryStore(tmpDir);
    await expect(
      store['resolve']('a1', 'notes.md'),
    ).resolves.toBeTypeOf('string');
  });

  it('canonicalises non-existent paths via deepest existing ancestor', async () => {
    // Fresh write: <base>/agent-1/never-existed/yet.txt. realpath would
    // throw on this path; the helper walks up to the existing ancestor
    // (baseDir, which exists), realpaths that, then re-appends the suffix.
    const baseDir = path.join(tmpDir, 'sandbox');
    const store = new FilesystemMemoryStore(baseDir);
    await expect(
      store['resolve']('agent-1', 'never-existed/yet.txt'),
    ).resolves.toBeTypeOf('string');
  });
});

// ─── #30 M-06: agentId character validation ──────────────────────────────

describe('M-06: validateAgentId guard at the store layer', () => {
  it('rejects path-segment-like agentIds', () => {
    expect(() => validateAgentId('../escape')).toThrow(/Invalid agentId/);
    expect(() => validateAgentId('a/b')).toThrow(/Invalid agentId/);
    expect(() => validateAgentId('a\\b')).toThrow(/Invalid agentId/);
    expect(() => validateAgentId('with spaces')).toThrow(/Invalid agentId/);
    expect(() => validateAgentId('with.dots')).toThrow(/Invalid agentId/);
  });

  it('accepts the conventional shape', () => {
    expect(() => validateAgentId('alice-bot')).not.toThrow();
    expect(() => validateAgentId('agent_007')).not.toThrow();
    expect(() => validateAgentId('A1B2c3')).not.toThrow();
  });

  it('accepts the empty string (workspace-tools mode)', () => {
    // createWorkspaceTools mounts file tools at the workspace root with
    // agentId = '', meaning the store sees the whole workingDir.
    expect(() => validateAgentId('')).not.toThrow();
  });

  it('rejects non-string input', () => {
    expect(() => validateAgentId(undefined as unknown as string)).toThrow();
    expect(() => validateAgentId(123 as unknown as string)).toThrow();
  });

  it('caps length at 64 characters', () => {
    expect(() => validateAgentId('x'.repeat(65))).toThrow(/too long/);
  });

  it('FilesystemMemoryStore propagates the rejection', async () => {
    const store = new FilesystemMemoryStore(tmpDir);
    await expect(store.read('../escape', 'foo')).rejects.toThrow(
      /Invalid agentId/,
    );
  });
});

// ─── #22 H-03: SavedAgentSchema validation in loadSavedAgent ──────────────

describe('H-03: SavedAgentSchema validates loaded JSON', () => {
  it('accepts a well-formed agent file', () => {
    const valid = {
      name: 'test',
      provider: 'anthropic',
      systemPrompt: 'Be helpful',
      memoryDir: '.agent-do',
      readOnly: false,
      maxIterations: 20,
      noTools: false,
      createdAt: '2026-04-17T00:00:00Z',
    };
    expect(SavedAgentSchema.parse(valid).name).toBe('test');
  });

  it('rejects unknown provider', () => {
    const r = SavedAgentSchema.safeParse({
      name: 'x', provider: 'evil-corp', systemPrompt: '',
      memoryDir: '.', readOnly: false, maxIterations: 1, noTools: false,
      createdAt: '',
    });
    expect(r.success).toBe(false);
  });

  it('rejects absolute memoryDir (would escape the project)', () => {
    const r = SavedAgentSchema.safeParse({
      name: 'x', provider: 'anthropic', systemPrompt: '',
      memoryDir: '/etc', readOnly: false, maxIterations: 1, noTools: false,
      createdAt: '',
    });
    expect(r.success).toBe(false);
    expect(r.success ? '' : r.error.issues[0]?.message).toMatch(/relative/);
  });

  it('rejects memoryDir containing `..`', () => {
    const r = SavedAgentSchema.safeParse({
      name: 'x', provider: 'anthropic', systemPrompt: '',
      memoryDir: 'foo/../etc', readOnly: false, maxIterations: 1, noTools: false,
      createdAt: '',
    });
    expect(r.success).toBe(false);
  });

  it('rejects oversize systemPrompt', () => {
    const r = SavedAgentSchema.safeParse({
      name: 'x', provider: 'anthropic', systemPrompt: 'a'.repeat(8193),
      memoryDir: '.', readOnly: false, maxIterations: 1, noTools: false,
      createdAt: '',
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown fields (.strict)', () => {
    const r = SavedAgentSchema.safeParse({
      name: 'x', provider: 'anthropic', systemPrompt: '',
      memoryDir: '.', readOnly: false, maxIterations: 1, noTools: false,
      createdAt: '', extraField: 'planted',
    });
    expect(r.success).toBe(false);
  });
});

describe('H-03: loadSavedAgent rejects invalid files at runtime', () => {
  let agentsDir: string;
  let originalCwd: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any;

  beforeEach(() => {
    originalCwd = process.cwd();
    agentsDir = path.join(tmpDir, '.agent-do', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    process.chdir(tmpDir);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    process.chdir(originalCwd);
    stderrSpy.mockRestore();
  });

  it('returns null and warns on malformed JSON', async () => {
    fs.writeFileSync(path.join(agentsDir, 'broken.json'), 'not json{{{');
    const result = await loadSavedAgent('broken');
    expect(result).toBeNull();
    expect(stderrSpy).toHaveBeenCalled();
    const writes = stderrSpy.mock.calls.map((c: unknown[]) => c[0] as string).join('');
    expect(writes).toMatch(/malformed/);
  });

  it('returns null and warns when memoryDir is absolute', async () => {
    fs.writeFileSync(path.join(agentsDir, 'planted.json'), JSON.stringify({
      name: 'planted',
      provider: 'anthropic',
      systemPrompt: 'You are evil',
      memoryDir: '/',
      readOnly: false,
      maxIterations: 100,
      noTools: false,
      createdAt: '',
    }));
    const result = await loadSavedAgent('planted');
    expect(result).toBeNull();
    const writes = stderrSpy.mock.calls.map((c: unknown[]) => c[0] as string).join('');
    expect(writes).toMatch(/memoryDir/);
  });

  it('drops prototype-pollution keys before validation', async () => {
    fs.writeFileSync(path.join(agentsDir, 'pp.json'), JSON.stringify({
      name: 'pp',
      provider: 'anthropic',
      systemPrompt: '',
      memoryDir: '.',
      readOnly: false,
      maxIterations: 1,
      noTools: false,
      createdAt: '',
      __proto__: { polluted: 'yes' },
    }));
    // The __proto__ key gets dropped by the reviver, so the remainder
    // is a valid SavedAgent and the load succeeds.
    const result = await loadSavedAgent('pp');
    expect(result).not.toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('loads a well-formed agent file', async () => {
    fs.writeFileSync(path.join(agentsDir, 'good.json'), JSON.stringify({
      name: 'good',
      provider: 'anthropic',
      systemPrompt: 'Be helpful',
      memoryDir: '.agent-do',
      readOnly: false,
      maxIterations: 20,
      noTools: false,
      createdAt: '',
    }));
    const result = await loadSavedAgent('good');
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('anthropic');
  });
});
