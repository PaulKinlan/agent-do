import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWorkspaceTools } from '../src/tools/workspace-tools.js';
import type { SandboxApi } from '../src/sandbox/types.js';

let workDir: string;

describe('createWorkspaceTools', () => {
  beforeEach(async () => {
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-do-ws-'));
    await fs.promises.writeFile(path.join(workDir, 'readme.md'), '# hello\nworld\n');
    await fs.promises.mkdir(path.join(workDir, 'src'));
    await fs.promises.writeFile(path.join(workDir, 'src', 'index.ts'), 'export const x = 1;\n');
  });

  afterEach(async () => {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  });

  async function exec(toolName: string, args: Record<string, unknown>, options?: { readOnly?: boolean }): Promise<string> {
    const tools = createWorkspaceTools(workDir, options);
    const tool = tools[toolName];
    if (!tool || !tool.execute) throw new Error(`Tool ${toolName} not found`);
    const raw = await (tool.execute as Function)(args, {});
    // Tools now return a ToolResult; legacy tests care about the model view.
    return typeof raw === 'string' ? raw : (raw.modelContent as string);
  }

  it('sees existing files in the working directory', async () => {
    const listing = await exec('list_directory', { path: '.' });
    expect(listing).toContain('readme.md');
    expect(listing).toContain('[dir] src');
  });

  it('reads a file from the working directory', async () => {
    const content = await exec('read_file', { path: 'readme.md' });
    expect(content).toContain('hello');
  });

  it('writes new files to the working directory', async () => {
    await exec('write_file', { path: 'new.txt', content: 'fresh content' });
    const written = await fs.promises.readFile(path.join(workDir, 'new.txt'), 'utf-8');
    expect(written).toBe('fresh content');
  });

  it('blocks writes when readOnly is set', async () => {
    const result = await exec('write_file', { path: 'no.txt', content: 'blocked' }, { readOnly: true });
    expect(result).toContain('read-only');
    const exists = fs.existsSync(path.join(workDir, 'no.txt'));
    expect(exists).toBe(false);
  });

  it('blocks path traversal outside the working directory', async () => {
    const result = await exec('read_file', { path: '../etc-passwd' });
    expect(result).toMatch(/Path traversal not allowed|File not found/i);
  });

  it('find_files lists nested files', async () => {
    const result = await exec('find_files', { path: '.' });
    expect(result).toContain('readme.md');
    expect(result).toContain('src');
    expect(result).toContain('src/index.ts');
  });

  it('grep_file searches across the working directory', async () => {
    const result = await exec('grep_file', { pattern: 'world' });
    expect(result).toContain('readme.md');
  });
});

describe('the deny list cannot be steered around with ".." or symlinks (agent-do-cn2)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-do-ws-cn2-'));
    await fs.promises.writeFile(path.join(dir, 'readme.md'), '# hello\nworld\n');
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  async function read(pathArg: string): Promise<string> {
    const tools = createWorkspaceTools(dir);
    const tool = tools['read_file'];
    if (!tool?.execute) throw new Error('read_file not found');
    const raw = await (tool.execute as Function)({ path: pathArg }, {});
    return typeof raw === 'string' ? raw : (raw.modelContent as string);
  }

  async function write(pathArg: string, content: string): Promise<string> {
    const tools = createWorkspaceTools(dir);
    const tool = tools['write_file'];
    if (!tool?.execute) throw new Error('write_file not found');
    const raw = await (tool.execute as Function)({ path: pathArg, content }, {});
    return typeof raw === 'string' ? raw : (raw.modelContent as string);
  }

  it('does not return a deny-listed file reached through a legal ".." segment', async () => {
    await fs.promises.writeFile(path.join(dir, '.env'), 'SECRET=leak\n');
    await fs.promises.mkdir(path.join(dir, 'sub'));
    const out = await read('sub/../.env');
    expect(out).not.toContain('SECRET=leak');
    expect(out).toContain('Blocked by deny list');
  });

  it('does not return a deny-listed file reached through an in-workspace symlink', async () => {
    await fs.promises.writeFile(path.join(dir, '.env'), 'SECRET=leak\n');
    await fs.promises.symlink(path.join(dir, '.env'), path.join(dir, 'peek'));
    const out = await read('peek');
    expect(out).not.toContain('SECRET=leak');
    expect(out).toContain('Blocked by deny list');
  });

  it('refuses a git-hook write reached through ".." or a symlinked .git, and writes nothing', async () => {
    await fs.promises.mkdir(path.join(dir, '.git', 'hooks'), { recursive: true });
    await fs.promises.mkdir(path.join(dir, 'sub'));
    expect(await write('sub/../.git/hooks/pre-commit', 'x')).toContain('Blocked by deny list');
    await fs.promises.symlink(path.join(dir, '.git'), path.join(dir, 'gitdir'));
    expect(await write('gitdir/hooks/post-commit', 'x')).toContain('Blocked by deny list');
    expect(fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-commit'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.git', 'hooks', 'post-commit'))).toBe(false);
  });

  it('still reads benign paths, including a benign ".." and a benign symlink', async () => {
    await fs.promises.mkdir(path.join(dir, 'src'));
    await fs.promises.symlink(path.join(dir, 'readme.md'), path.join(dir, 'alias'));
    expect(await read('src/../readme.md')).toContain('hello');
    expect(await read('alias')).toContain('hello');
  });
});

describe('sandbox-backed workspaces canonicalise on the substrate (agent-do-kov)', () => {
  const virtualRoot = '/virtual-cn2-workspace';
  let physical: string;

  const toPhysical = (p: string) => path.join(physical, path.relative(virtualRoot, p));
  const toVirtual = (p: string) =>
    path.posix.join(virtualRoot, path.relative(physical, p).split(path.sep).join('/'));

  /** A temp directory dressed as a virtual workspace, like a remote connector. */
  const makeSandbox = (): SandboxApi => ({
    readFile: (p) => fs.promises.readFile(toPhysical(p), 'utf8'),
    readFileBuffer: async (p) => new Uint8Array(await fs.promises.readFile(toPhysical(p))),
    writeFile: (p, content) => fs.promises.writeFile(toPhysical(p), content),
    stat: async (p) => {
      const st = await fs.promises.lstat(toPhysical(p));
      return {
        isFile: st.isFile(),
        isDirectory: st.isDirectory(),
        isSymbolicLink: st.isSymbolicLink(),
        size: st.size,
        mtime: st.mtime,
      };
    },
    readdir: (p) => fs.promises.readdir(toPhysical(p)),
    exists: async (p) => fs.promises.access(toPhysical(p)).then(() => true, () => false),
    mkdir: async (p, o) => { await fs.promises.mkdir(toPhysical(p), o); },
    rm: async (p, o) => { await fs.promises.rm(toPhysical(p), o); },
    exec: async () => ({ stdout: '', stderr: 'not implemented', exitCode: 1 }),
    realpath: async (p) => toVirtual(await fs.promises.realpath(toPhysical(p))),
  });

  beforeEach(async () => {
    physical = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-do-substrate-'));
  });

  afterEach(async () => {
    await fs.promises.rm(physical, { recursive: true, force: true });
  });

  async function exec(name: string, args: Record<string, unknown>, sandbox = makeSandbox()): Promise<string> {
    const tools = createWorkspaceTools(virtualRoot, { sandbox });
    const tool = tools[name];
    if (!tool?.execute) throw new Error(`${name} not found`);
    const raw = await (tool.execute as Function)(args, {});
    return typeof raw === 'string' ? raw : (raw.modelContent as string);
  }

  it('blocks a deny-listed file reached through a substrate-only symlink', async () => {
    // The file and the symlink exist only on the substrate; the host has no
    // /virtual-cn2-workspace at all, which is what defeated host realpath.
    await fs.promises.writeFile(path.join(physical, '.env'), 'SECRET=remote-only\n');
    await fs.promises.symlink('.env', path.join(physical, 'alias'));
    expect(await exec('read_file', { path: '.env' })).toContain('Blocked by deny list');
    const aliased = await exec('read_file', { path: 'alias' });
    expect(aliased).not.toContain('SECRET=remote-only');
    expect(aliased).toContain('Blocked by deny list');
  });

  it('blocks a substrate symlink that leaves the virtual workspace', async () => {
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-do-outside-'));
    try {
      await fs.promises.writeFile(path.join(outside, 'secret.txt'), 'SECRET=outside\n');
      await fs.promises.symlink(path.join(outside, 'secret.txt'), path.join(physical, 'escape'));
      const out = await exec('read_file', { path: 'escape' });
      expect(out).not.toContain('SECRET=outside');
      expect(out).toContain('Blocked by deny list');
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });

  it('still reads benign substrate paths and benign symlinks', async () => {
    await fs.promises.writeFile(path.join(physical, 'readme.md'), '# hello\n');
    await fs.promises.symlink('readme.md', path.join(physical, 'alias-readme'));
    expect(await exec('read_file', { path: 'readme.md' })).toContain('hello');
    expect(await exec('read_file', { path: 'alias-readme' })).toContain('hello');
  });
});

describe('fresh writes through symlinked directories (agent-do-ro9)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-do-ro9-'));
    await fs.promises.mkdir(path.join(dir, '.git', 'hooks'), { recursive: true });
    await fs.promises.symlink(path.join(dir, '.git'), path.join(dir, 'alias'));
    await fs.promises.mkdir(path.join(dir, 'src'));
    await fs.promises.symlink(path.join(dir, 'src'), path.join(dir, 'link-src'));
  });
  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  async function write(relPath: string, sandbox?: SandboxApi): Promise<string> {
    const tools = createWorkspaceTools(dir, sandbox ? { sandbox } : {});
    const tool = tools.write_file;
    if (!tool?.execute) throw new Error('write_file not found');
    const raw = await (tool.execute as Function)({ path: relPath, content: 'planted' }, {});
    return typeof raw === 'string' ? raw : (raw.modelContent as string);
  }

  it('blocks the direct target and a fresh file behind a symlinked directory', async () => {
    expect(await write('.git/hooks/existing-test')).toContain('Blocked by deny list');
    expect(await write('alias/hooks/new-test')).toContain('Blocked by deny list');
    expect(await write('alias/hooks/deep-a/deep-b')).toContain('Blocked by deny list');
    expect(fs.existsSync(path.join(dir, '.git', 'hooks', 'new-test'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.git', 'hooks', 'deep-a'))).toBe(false);
  });

  it('still allows a fresh file behind a symlink that stays inside the workspace', async () => {
    expect(await write('link-src/new.txt')).toContain('Wrote');
    expect(fs.existsSync(path.join(dir, 'src', 'new.txt'))).toBe(true);
  });

  it('blocks the same fresh write when the tools are sandbox-backed', async () => {
    // The substrate does not have the leaf yet, which is exactly the case where
    // an ENOENT fallback to the raw path skipped the deny list.
    // Same fixture as the host cases: `alias` -> `.git`, and the virtual root
    // maps onto it, so the substrate sees the same shape the model does.
    const physical = dir;
    const virtualRoot = '/virtual-ro9-workspace';
    const toPhysical = (p: string) => path.join(physical, path.relative(virtualRoot, p));
    const toVirtual = (p: string) =>
      path.posix.join(virtualRoot, path.relative(physical, p).split(path.sep).join('/'));
    const sandbox: SandboxApi = {
      readFile: (p) => fs.promises.readFile(toPhysical(p), 'utf8'),
      readFileBuffer: async (p) => new Uint8Array(await fs.promises.readFile(toPhysical(p))),
      writeFile: (p, content) => fs.promises.writeFile(toPhysical(p), content),
      stat: async (p) => {
        const st = await fs.promises.lstat(toPhysical(p));
        return {
          isFile: st.isFile(),
          isDirectory: st.isDirectory(),
          isSymbolicLink: st.isSymbolicLink(),
          size: st.size,
          mtime: st.mtime,
        };
      },
      readdir: (p) => fs.promises.readdir(toPhysical(p)),
      exists: async (p) => fs.promises.access(toPhysical(p)).then(() => true, () => false),
      mkdir: async (p, o) => { await fs.promises.mkdir(toPhysical(p), o); },
      rm: async (p, o) => { await fs.promises.rm(toPhysical(p), o); },
      exec: async () => ({ stdout: '', stderr: 'not implemented', exitCode: 1 }),
      realpath: async (p) => toVirtual(await fs.promises.realpath(toPhysical(p))),
      readlink: (p) => fs.promises.readlink(toPhysical(p)),
    };
    const tools = createWorkspaceTools(virtualRoot, { sandbox });
    const run = async (p: string) => {
      const raw = await (tools.write_file!.execute as Function)({ path: p, content: 'planted' }, {});
      return typeof raw === 'string' ? raw : (raw.modelContent as string);
    };
    expect(await run('.git/hooks/direct-new')).toContain('Blocked by deny list');
    expect(await run('alias/hooks/new-test')).toContain('Blocked by deny list');
    expect(fs.existsSync(path.join(physical, '.git', 'hooks', 'new-test'))).toBe(false);
  });
});

describe('dangling symlinks resolve to their target before policy runs (agent-do-5ww)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-do-5ww-'));
    await fs.promises.mkdir(path.join(dir, '.git', 'hooks'), { recursive: true });
    await fs.promises.mkdir(path.join(dir, 'notes'), { recursive: true });
    // The point of a *dangling* link: its target does not exist yet, so
    // realpath reports ENOENT and a resolver that only walks up would keep the
    // innocent alias in its answer while the write followed the link.
    await fs.promises.symlink(path.join(dir, '.git', 'hooks', 'planted'), path.join(dir, 'planted-abs'));
    await fs.promises.symlink('.git/hooks/planted', path.join(dir, 'planted-rel'));
    await fs.promises.symlink(path.join(dir, 'chain-b'), path.join(dir, 'chain-a'));
    await fs.promises.symlink(path.join(dir, '.git', 'hooks', 'deep', 'planted'), path.join(dir, 'chain-b'));
    await fs.promises.symlink('notes/todo.md', path.join(dir, 'safe-alias'));
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  async function run(
    name: string,
    args: Record<string, unknown>,
    sandbox?: SandboxApi,
    root?: string,
  ): Promise<string> {
    const tools = createWorkspaceTools(root ?? dir, sandbox ? { sandbox } : {});
    const tool = tools[name];
    if (!tool?.execute) throw new Error(`${name} not found`);
    const raw = await (tool.execute as Function)(args, {});
    return typeof raw === 'string' ? raw : (raw.modelContent as string);
  }

  // ---- negative: every route through a dangling link to a denied target ----
  it('blocks a fresh write through an absolute dangling symlink into .git', async () => {
    expect(await run('write_file', { path: 'planted-abs', content: 'x' })).toContain('Blocked by deny list');
    expect(fs.existsSync(path.join(dir, '.git', 'hooks', 'planted'))).toBe(false);
  });

  it('blocks a fresh write through a relative dangling symlink into .git', async () => {
    expect(await run('write_file', { path: 'planted-rel', content: 'x' })).toContain('Blocked by deny list');
    expect(fs.existsSync(path.join(dir, '.git', 'hooks', 'planted'))).toBe(false);
  });

  it('blocks a dangling symlink chain', async () => {
    expect(await run('write_file', { path: 'chain-a', content: 'x' })).toContain('Blocked by deny list');
    expect(fs.existsSync(path.join(dir, '.git', 'hooks', 'deep', 'planted'))).toBe(false);
  });

  it('blocks reading through a dangling symlink to a denied target', async () => {
    expect(await run('read_file', { path: 'planted-rel' })).toContain('Blocked by deny list');
  });

  it('blocks a fresh child written through a dangling symlink', async () => {
    // The link resolves to .git/hooks/planted, which does not exist; the write
    // targets a child of it, so only the resolved prefix can match a rule.
    expect(await run('write_file', { path: 'planted-abs/nested/x', content: 'x' })).toContain(
      'Blocked by deny list',
    );
    expect(fs.existsSync(path.join(dir, '.git', 'hooks', 'planted', 'nested', 'x'))).toBe(false);
  });

  it('blocks the same shapes when the tools are sandbox-backed', async () => {
    const physical = dir;
    const virtualRoot = '/virtual-5ww-workspace';
    const toPhysical = (p: string) => path.join(physical, path.relative(virtualRoot, p));
    const toVirtual = (p: string) =>
      path.posix.join(virtualRoot, path.relative(physical, p).split(path.sep).join('/'));
    const sandbox: SandboxApi = {
      readFile: (p) => fs.promises.readFile(toPhysical(p), 'utf8'),
      readFileBuffer: async (p) => new Uint8Array(await fs.promises.readFile(toPhysical(p))),
      writeFile: (p, content) => fs.promises.writeFile(toPhysical(p), content),
      stat: async (p) => {
        const st = await fs.promises.lstat(toPhysical(p));
        return {
          isFile: st.isFile(),
          isDirectory: st.isDirectory(),
          isSymbolicLink: st.isSymbolicLink(),
          size: st.size,
          mtime: st.mtime,
        };
      },
      readdir: (p) => fs.promises.readdir(toPhysical(p)),
      exists: async (p) => fs.promises.access(toPhysical(p)).then(() => true, () => false),
      mkdir: async (p, o) => { await fs.promises.mkdir(toPhysical(p), o); },
      rm: async (p, o) => { await fs.promises.rm(toPhysical(p), o); },
      exec: async () => ({ stdout: '', stderr: 'not implemented', exitCode: 1 }),
      realpath: async (p) => toVirtual(await fs.promises.realpath(toPhysical(p))),
      readlink: (p) => fs.promises.readlink(toPhysical(p)),
    };
    // Relative targets keep the link's shape valid in the virtual namespace.
    expect(await run('write_file', { path: 'planted-rel', content: 'x' }, sandbox, virtualRoot)).toContain(
      'Blocked by deny list',
    );
    expect(fs.existsSync(path.join(dir, '.git', 'hooks', 'planted'))).toBe(false);
  });

  // ---- agent-do-qhn: the two bounds are separate, and exhaustion fails closed ----
  it('blocks a symlink that is hidden behind more missing directories than the hop budget', async () => {
    // rev-30's shape: >32 nonexistent nested directories BEFORE the symlink is
    // reached. When the ancestor walk shares the symlink budget with symlink
    // expansion, the budget is spent long before the link is inspected and the
    // raw path is permitted. The walk is bounded by the path's own depth only.
    await fs.promises.symlink('.git', path.join(dir, 'alias'));
    const deep = Array.from({ length: 40 }, (_, i) => `d${i}`).join('/');
    expect(await run('write_file', { path: `alias/hooks/${deep}/planted`, content: 'x' })).toContain(
      'Blocked by deny list',
    );
    expect(fs.existsSync(path.join(dir, '.git', 'hooks', 'd0'))).toBe(false);
  });

  it('blocks a dangling symlink chain longer than the hop budget', async () => {
    // Budget exhaustion specifically: realpath resolves a *valid* chain in one
    // call, but each link of a dangling chain costs one hop, so 35 links exceed
    // the bound of 32. On exhaustion there is no safe path to return, so the
    // policy must refuse rather than fall back to the raw path.
    const links = Array.from({ length: 35 }, (_, i) => `c${i}`);
    for (let i = 0; i < links.length - 1; i += 1) {
      await fs.promises.symlink(links[i + 1], path.join(dir, links[i]));
    }
    await fs.promises.symlink(path.join(dir, '.git', 'hooks', 'planted'), path.join(dir, links[links.length - 1]));
    const out = await run('write_file', { path: links[0], content: 'x' });
    expect(out).toContain('Blocked by deny list');
    expect(fs.existsSync(path.join(dir, '.git', 'hooks', 'planted'))).toBe(false);
  });

  it('still allows a deep path with many missing directories and no symlink', async () => {
    // The positive control for the above: an unbounded ancestor walk must not
    // turn an ordinary deep path into a refusal.
    const deep = Array.from({ length: 40 }, (_, i) => `a${i}`).join('/');
    const out = await run('write_file', { path: `notes/${deep}/out.txt`, content: 'x' });
    expect(out).not.toContain('Blocked by deny list');
    expect(out).not.toContain('unresolved');
  });

  it('blocks a symlink cycle, reporting the unattested path rule', async () => {
    // A cycle never resolves, so the hop budget is genuinely exhausted; there is
    // no safe path to return, and the policy must say so rather than shrug.
    await fs.promises.symlink('loop-b', path.join(dir, 'loop-a'));
    await fs.promises.symlink('loop-a', path.join(dir, 'loop-b'));
    const out = await run('read_file', { path: 'loop-a' });
    expect(out).toContain('Blocked by deny list');
    // The model-facing message names the path; the *rule* is in `data`, per the
    // ToolResult convention for a blocked result.
    const tools = createWorkspaceTools(dir);
    const raw = (await (tools.read_file!.execute as Function)({ path: 'loop-a' }, {})) as {
      modelContent: string;
      data?: Record<string, unknown>;
    };
    expect(raw.data?.rule).toBe('unresolved-path');
    expect(raw.data?.blocked).toBe(true);
  });

  // ---- positive: a dangling link that stays inside the workspace still works ----
  it('allows a fresh write on a dangling symlink whose target is inside the workspace', async () => {
    // The policy resolves it to notes/todo.md, which is inside the workspace, so
    // it is permitted. Where the store then puts the bytes is the store's
    // business - FilesystemMemoryStore writes atomically, which replaces the
    // link rather than writing through it - so assert the outcome: not blocked,
    // and readable afterwards.
    expect(await run('write_file', { path: 'safe-alias', content: 'hello' })).toContain('Wrote');
    expect(await run('read_file', { path: 'safe-alias' })).toContain('hello');
    // And nothing landed outside the workspace.
    expect(fs.existsSync(path.join(dir, 'notes', 'todo.md')) || fs.existsSync(path.join(dir, 'safe-alias'))).toBe(
      true,
    );
  });

  it('still allows ordinary paths and an ordinary in-workspace symlink', async () => {
    await fs.promises.writeFile(path.join(dir, 'notes', 'real.md'), 'body');
    await fs.promises.symlink('notes/real.md', path.join(dir, 'real-alias'));
    expect(await run('read_file', { path: 'notes/real.md' })).toContain('body');
    expect(await run('read_file', { path: 'real-alias' })).toContain('body');
  });
});
