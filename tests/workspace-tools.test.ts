import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWorkspaceTools } from '../src/tools/workspace-tools.js';

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
