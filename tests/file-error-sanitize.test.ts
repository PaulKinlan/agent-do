import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createFileTools } from '../src/tools/file-tools.js';
import { FilesystemMemoryStore } from '../src/stores/filesystem.js';

let baseDir: string;

async function exec(tools: ReturnType<typeof createFileTools>, toolName: string, args: Record<string, unknown>) {
  const tool = tools[toolName];
  if (!tool || !tool.execute) throw new Error(`Tool ${toolName} not found`);
  return (tool.execute as Function)(args, {}) as Promise<string>;
}

describe('file tools — error sanitization', () => {
  beforeEach(async () => {
    baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-do-san-'));
  });

  afterEach(async () => {
    await fs.promises.rm(baseDir, { recursive: true, force: true });
  });

  it('missing-file error does not leak absolute paths', async () => {
    const store = new FilesystemMemoryStore(baseDir);
    const tools = createFileTools(store, 'test');
    const result = await exec(tools, 'read_file', { path: 'nope.txt' });
    expect(result).toMatch(/File not found/);
    expect(result).toContain('nope.txt');
    expect(result).not.toContain(baseDir);
    expect(result).not.toContain(os.tmpdir());
  });

  it('ENOENT on list_directory is sanitized with no base-path leak', async () => {
    const store = new FilesystemMemoryStore(baseDir);
    const tools = createFileTools(store, 'test');
    // list() on non-existent dir returns []; to exercise ENOENT we invoke
    // grep on a definitely-missing subpath, which attempts to readdir.
    const result = await exec(tools, 'grep_file', { pattern: 'x', path: 'no/such/dir' });
    // Either a sanitised error, or "No matches" — both are acceptable; neither may leak the baseDir.
    expect(result).not.toContain(baseDir);
    expect(result).not.toContain(os.tmpdir());
  });

  it('EACCES maps to a sanitized "Permission denied"', async () => {
    // Create a file then chmod it 000. Only do this on POSIX; skip on Windows.
    if (process.platform === 'win32') return;
    const filePath = path.join(baseDir, 'test', 'locked.txt');
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, 'secret');
    await fs.promises.chmod(filePath, 0o000);

    try {
      const store = new FilesystemMemoryStore(baseDir);
      const tools = createFileTools(store, 'test');
      const result = await exec(tools, 'read_file', { path: 'locked.txt' });
      // Root can still read; test may not hit EACCES in that case.
      if (process.getuid && process.getuid() === 0) return;
      expect(result).toMatch(/Permission denied on locked.txt/);
      expect(result).not.toContain(baseDir);
    } finally {
      await fs.promises.chmod(filePath, 0o644).catch(() => undefined);
    }
  });

  it('Path traversal guard message is preserved (no leak, no code)', async () => {
    const store = new FilesystemMemoryStore(baseDir);
    const tools = createFileTools(store, 'test');
    const result = await exec(tools, 'read_file', { path: '../../../etc/passwd' });
    expect(result).toContain('Path traversal');
    expect(result).not.toContain(baseDir);
  });

  it('write error on a read-only store sanitizes to the op-specific message', async () => {
    const store = new FilesystemMemoryStore(baseDir, { readOnly: true });
    const tools = createFileTools(store, 'test');
    const result = await exec(tools, 'write_file', { path: 'new.txt', content: 'x' });
    // The readOnly guard throws a known message without a path prefix, so we preserve it.
    expect(result).toContain('read-only');
  });
});
