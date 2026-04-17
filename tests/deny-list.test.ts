import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createDenyGuard,
  DEFAULT_READ_DENY,
  DEFAULT_WRITE_DENY,
} from '../src/tools/deny-list.js';
import { createWorkspaceTools } from '../src/tools/workspace-tools.js';
import type { ToolResult } from '../src/tools/types.js';

let workDir: string;

describe('createDenyGuard', () => {
  beforeEach(async () => {
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-do-deny-'));
  });
  afterEach(async () => {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  });

  describe('defaults', () => {
    const g = () => createDenyGuard(workDir, { skipAgentDoIgnore: true });

    it('blocks reads of .env and variants', () => {
      expect(g().checkRead('.env').blocked).toBe(true);
      expect(g().checkRead('.env.local').blocked).toBe(true);
      expect(g().checkRead('.env.production').blocked).toBe(true);
    });

    it('blocks reads of key material', () => {
      expect(g().checkRead('server.pem').blocked).toBe(true);
      expect(g().checkRead('server.key').blocked).toBe(true);
      expect(g().checkRead('id_rsa').blocked).toBe(true);
      expect(g().checkRead('id_rsa.pub').blocked).toBe(true);
      expect(g().checkRead('id_ed25519').blocked).toBe(true);
    });

    it('blocks writes to .git/** and node_modules/**', () => {
      expect(g().checkWrite('.git/HEAD').blocked).toBe(true);
      expect(g().checkWrite('.git/hooks/pre-commit').blocked).toBe(true);
      expect(g().checkWrite('node_modules/foo/index.js').blocked).toBe(true);
    });

    it('does not block reads of node_modules or .git/HEAD (useful for recon)', () => {
      expect(g().checkRead('node_modules/foo/index.js').blocked).toBe(false);
      expect(g().checkRead('.git/HEAD').blocked).toBe(false);
    });

    it('still blocks reads of .git/objects and hooks (sensitive internals)', () => {
      expect(g().checkRead('.git/objects/ab/123').blocked).toBe(true);
      expect(g().checkRead('.git/hooks/pre-commit').blocked).toBe(true);
    });

    it('returns the matching rule for operator visibility', () => {
      const decision = g().checkRead('.env');
      expect(decision.blocked).toBe(true);
      expect(decision.rule).toBeDefined();
      expect(DEFAULT_READ_DENY).toContain(decision.rule);
    });

    it('allows ordinary source files', () => {
      expect(g().checkRead('src/app.ts').blocked).toBe(false);
      expect(g().checkRead('README.md').blocked).toBe(false);
      expect(g().checkWrite('src/app.ts').blocked).toBe(false);
    });

    it('normalises leading ./ and back-slashes', () => {
      expect(g().checkRead('./.env').blocked).toBe(true);
      expect(g().checkRead('.ssh\\config').blocked).toBe(true);
    });

    it('treats path traversal as out-of-scope (store handles it)', () => {
      // `ignore` throws on `..`; we swallow that and let the store catch it.
      expect(g().checkRead('../secret').blocked).toBe(false);
      expect(g().checkWrite('../../etc/passwd').blocked).toBe(false);
    });
  });

  describe('options', () => {
    it('extra patterns are additive', () => {
      const guard = createDenyGuard(workDir, {
        extra: ['secrets/**', '*.cred'],
        skipAgentDoIgnore: true,
      });
      expect(guard.checkRead('secrets/a.txt').blocked).toBe(true);
      expect(guard.checkRead('user.cred').blocked).toBe(true);
      expect(guard.checkRead('.env').blocked).toBe(true); // default still applies
    });

    it('includeSensitive disables the built-in defaults', () => {
      const guard = createDenyGuard(workDir, {
        includeSensitive: true,
        skipAgentDoIgnore: true,
      });
      expect(guard.checkRead('.env').blocked).toBe(false);
      expect(guard.checkWrite('.git/hooks/pre-commit').blocked).toBe(false);
    });

    it('includeSensitive still honours caller-supplied extras', () => {
      const guard = createDenyGuard(workDir, {
        includeSensitive: true,
        extra: ['custom-secret'],
        skipAgentDoIgnore: true,
      });
      expect(guard.checkRead('custom-secret').blocked).toBe(true);
      expect(guard.checkRead('.env').blocked).toBe(false);
    });

    it('loads .agent-doignore if present at workspace root', async () => {
      await fs.promises.writeFile(
        path.join(workDir, '.agent-doignore'),
        '# project secrets\nsecrets/**\n*.local\n',
      );
      const guard = createDenyGuard(workDir);
      expect(guard.checkRead('secrets/x').blocked).toBe(true);
      expect(guard.checkRead('config.local').blocked).toBe(true);
    });
  });
});

describe('createWorkspaceTools with deny list', () => {
  beforeEach(async () => {
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-do-ws-deny-'));
    await fs.promises.writeFile(path.join(workDir, 'README.md'), '# hello\n');
    await fs.promises.writeFile(path.join(workDir, '.env'), 'SECRET=abc');
    await fs.promises.mkdir(path.join(workDir, 'node_modules', 'foo'), { recursive: true });
    await fs.promises.writeFile(path.join(workDir, 'node_modules', 'foo', 'index.js'), 'ok');
    await fs.promises.mkdir(path.join(workDir, 'src'));
    await fs.promises.writeFile(path.join(workDir, 'src', 'app.ts'), 'export const x = 1;');
  });
  afterEach(async () => {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  });

  async function call(toolName: string, args: Record<string, unknown>, options = {}): Promise<ToolResult> {
    const tools = createWorkspaceTools(workDir, { skipAgentDoIgnore: true, ...options });
    return (tools[toolName]!.execute as Function)(args, {}) as Promise<ToolResult>;
  }

  it('blocks read_file of .env', async () => {
    const r = await call('read_file', { path: '.env' });
    expect(r.blocked).toBe(true);
    expect(r.data?.reason).toBe('deny-list');
    expect(r.modelContent).toContain('Blocked by deny list');
    // Model sees only that it was blocked — not the rule pattern:
    expect(r.modelContent).not.toContain('.env*');
    // Operator summary shows the matched rule:
    expect(r.userSummary).toContain('.env');
  });

  it('blocks write_file to node_modules', async () => {
    const r = await call('write_file', {
      path: 'node_modules/evil/persist.js',
      content: 'bad',
    });
    expect(r.blocked).toBe(true);
    expect(r.data?.rule).toContain('node_modules');
  });

  it('blocks write_file to .git/hooks/**', async () => {
    const r = await call('write_file', {
      path: '.git/hooks/pre-commit',
      content: '#!/bin/sh\nsteal',
    });
    expect(r.blocked).toBe(true);
  });

  it('allows reads of node_modules (recon OK)', async () => {
    const r = await call('read_file', { path: 'node_modules/foo/index.js' });
    expect(r.blocked).toBeFalsy();
    expect(r.modelContent).toContain('<tool_output');
  });

  it('allows ordinary project files', async () => {
    const r = await call('read_file', { path: 'src/app.ts' });
    expect(r.blocked).toBeFalsy();
    expect(r.modelContent).toContain('export const x = 1;');
  });

  it('filters .env out of list_directory results', async () => {
    const r = await call('list_directory', { path: '.' });
    expect(r.modelContent).not.toContain('.env');
    expect(r.modelContent).toContain('README.md');
    expect(r.userSummary).toMatch(/hidden by deny list/);
    expect(r.data?.hiddenByDenyList).toBeGreaterThanOrEqual(1);
  });

  it('--include-sensitive reopens the defaults', async () => {
    const r = await call('read_file', { path: '.env' }, { includeSensitive: true });
    expect(r.blocked).toBeFalsy();
    expect(r.modelContent).toContain('SECRET=abc');
  });

  it('extra --exclude patterns are enforced', async () => {
    await fs.promises.writeFile(path.join(workDir, 'custom.secret'), 'xxx');
    const r = await call(
      'read_file',
      { path: 'custom.secret' },
      { exclude: ['*.secret'] },
    );
    expect(r.blocked).toBe(true);
    expect(r.data?.rule).toBe('*.secret');
  });
});
