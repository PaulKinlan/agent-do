/**
 * SandboxBackedMemoryStore — adapt a {@link SandboxApi} to the
 * {@link MemoryStore} interface.
 *
 * This is the bridge that lets existing file/memory/workspace tools
 * work unchanged on top of any sandbox connector. Construct one with
 * a sandbox + a base directory inside the sandbox, and pass it to
 * `createFileTools` / `createMemoryTools` / `createWorkspaceTools` like
 * you would `FilesystemMemoryStore`. Every read, write, and search
 * routes through the connector.
 *
 * Usage:
 *
 *   const sandbox = await createJustBashSandbox({ files: { ... } });
 *   const store = new SandboxBackedMemoryStore(sandbox, '/data');
 *   const agent = createAgent({
 *     id: 'geo', name: 'Geo', model,
 *     sandbox,
 *     tools: { ...createFileTools(store, 'geo') },
 *   });
 *
 * Path conventions:
 *
 * - The store stores agent files under `{root}/{agentId}/...` — same
 *   layout as `FilesystemMemoryStore`. `agentId = ""` mounts at
 *   `{root}` for the workspace-tools mode.
 * - Paths handed to the underlying `SandboxApi` are absolute strings
 *   joined with `/`. Connectors interpret them in their own root
 *   (host fs for noop, virtual fs for just-bash, VM fs for
 *   Vercel/Deno).
 *
 * Soft safety knobs (`readOnly`, `onBeforeWrite`) mirror the equivalents
 * on `FilesystemMemoryStore`. The sandbox itself is the strong boundary;
 * these knobs add policy on top.
 */

import type { MemoryStore, FileEntry, SearchOptions } from '../stores.js';
import type { SandboxApi } from '../sandbox/types.js';
import { validateAgentId } from './agent-id.js';
import { buildLineMatcher } from './search-matcher.js';

export interface SandboxBackedMemoryStoreOptions {
  /** Block all write operations. Throws on write/append/delete/mkdir. */
  readOnly?: boolean;
  /**
   * Per-write hook. Receives the canonicalised relative path. Return
   * `false` to block; throw to surface a custom error.
   */
  onBeforeWrite?: (
    agentId: string,
    canonicalPath: string,
    operation: 'write' | 'append' | 'delete' | 'mkdir',
  ) => boolean | Promise<boolean>;
  /**
   * Cap on the number of search hits returned. Mirrors
   * `FilesystemMemoryStore`'s implicit 100-result cap so search results
   * don't unbounded-grow.
   */
  maxSearchResults?: number;
}

export class SandboxBackedMemoryStore implements MemoryStore {
  private readonly options: SandboxBackedMemoryStoreOptions;

  constructor(
    private readonly sandbox: SandboxApi,
    private readonly root: string = '/workspace',
    options?: SandboxBackedMemoryStoreOptions,
  ) {
    this.options = options ?? {};
  }

  private resolve(agentId: string, filePath: string): string {
    validateAgentId(agentId);
    const normalised = normalisePath(filePath || '.');
    if (normalised === null) {
      throw new Error('Path traversal not allowed');
    }
    const base = stripTrailingSlash(this.root) || '/';
    const agentSegment = agentId ? `/${agentId}` : '';
    if (normalised === '' || normalised === '.') {
      return `${base}${agentSegment}` || '/';
    }
    return `${base}${agentSegment}/${normalised}`;
  }

  private async checkWrite(
    agentId: string,
    filePath: string,
    op: 'write' | 'append' | 'delete' | 'mkdir',
  ): Promise<void> {
    if (this.options.readOnly) {
      throw new Error(`Write blocked: store is read-only (attempted ${op} on ${filePath})`);
    }
    if (this.options.onBeforeWrite) {
      const allowed = await Promise.resolve(
        this.options.onBeforeWrite(agentId, normalisePath(filePath) ?? filePath, op),
      );
      if (!allowed) {
        throw new Error(`Write blocked by onBeforeWrite callback (attempted ${op} on ${filePath})`);
      }
    }
  }

  async read(agentId: string, filePath: string): Promise<string> {
    const full = this.resolve(agentId, filePath);
    try {
      return await this.sandbox.readFile(full);
    } catch (err) {
      // Normalise to the contract used by other stores so file_tools'
      // error mapping doesn't have to special-case the sandbox layer.
      throw new Error(`File not found: ${filePath}`, { cause: err });
    }
  }

  async write(agentId: string, filePath: string, content: string): Promise<void> {
    await this.checkWrite(agentId, filePath, 'write');
    const full = this.resolve(agentId, filePath);
    const parent = parentDir(full);
    if (parent && parent !== '/' && parent !== full) {
      await this.sandbox.mkdir(parent, { recursive: true });
    }
    await this.sandbox.writeFile(full, content);
  }

  async append(agentId: string, filePath: string, content: string): Promise<void> {
    await this.checkWrite(agentId, filePath, 'append');
    const full = this.resolve(agentId, filePath);
    let existing = '';
    if (await this.sandbox.exists(full)) {
      existing = await this.sandbox.readFile(full);
    } else {
      const parent = parentDir(full);
      if (parent && parent !== '/' && parent !== full) {
        await this.sandbox.mkdir(parent, { recursive: true });
      }
    }
    await this.sandbox.writeFile(full, existing + content);
  }

  async delete(agentId: string, filePath: string): Promise<void> {
    await this.checkWrite(agentId, filePath, 'delete');
    const full = this.resolve(agentId, filePath);
    try {
      await this.sandbox.rm(full, { force: true });
    } catch {
      // Idempotent — match FilesystemMemoryStore semantics.
    }
  }

  async list(agentId: string, dirPath?: string): Promise<FileEntry[]> {
    const full = this.resolve(agentId, dirPath ?? '.');
    let names: string[];
    try {
      names = await this.sandbox.readdir(full);
    } catch {
      return [];
    }
    const entries: FileEntry[] = [];
    for (const name of names) {
      const child = `${stripTrailingSlash(full)}/${name}`;
      try {
        const s = await this.sandbox.stat(child);
        entries.push({
          name,
          type: s.isDirectory ? 'directory' : 'file',
          size: s.isFile ? s.size : undefined,
        });
      } catch {
        // Best-effort: if stat fails treat the entry as a file.
        entries.push({ name, type: 'file' });
      }
    }
    return entries;
  }

  async mkdir(agentId: string, dirPath: string): Promise<void> {
    await this.checkWrite(agentId, dirPath, 'mkdir');
    const full = this.resolve(agentId, dirPath);
    await this.sandbox.mkdir(full, { recursive: true });
  }

  async exists(agentId: string, filePath: string): Promise<boolean> {
    try {
      const full = this.resolve(agentId, filePath);
      return await this.sandbox.exists(full);
    } catch {
      return false;
    }
  }

  async search(
    agentId: string,
    pattern: string,
    dirPath?: string,
    options?: SearchOptions,
  ): Promise<Array<{ path: string; line: string }>> {
    const matcher = buildLineMatcher(pattern, { asRegex: options?.regex === true });
    const max = this.options.maxSearchResults ?? 100;
    const root = this.resolve(agentId, dirPath ?? '.');
    const agentRoot = this.resolve(agentId, '.');
    const results: Array<{ path: string; line: string }> = [];
    await this.searchRecursive(root, agentRoot, matcher, results, max);
    return results;
  }

  private async searchRecursive(
    dir: string,
    agentRoot: string,
    matcher: (line: string) => boolean,
    results: Array<{ path: string; line: string }>,
    max: number,
  ): Promise<void> {
    if (results.length >= max) return;
    let names: string[];
    try {
      names = await this.sandbox.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (results.length >= max) return;
      if (name === 'node_modules' || name === '.git') continue;
      const child = `${stripTrailingSlash(dir)}/${name}`;
      let stat;
      try {
        stat = await this.sandbox.stat(child);
      } catch {
        continue;
      }
      if (stat.isDirectory) {
        await this.searchRecursive(child, agentRoot, matcher, results, max);
        continue;
      }
      if (!stat.isFile) continue;
      let content: string;
      try {
        content = await this.sandbox.readFile(child);
      } catch {
        continue;
      }
      const relative = relativeFrom(agentRoot, child);
      for (const line of content.split('\n')) {
        if (matcher(line)) {
          results.push({ path: relative, line: line.trim() });
          if (results.length >= max) return;
        }
      }
    }
  }
}

/**
 * Strip a `..`-traversal-shaped path. Returns the cleaned path or
 * `null` if the path tries to escape its scope (`..` segments that
 * outpace the leading segments).
 */
function normalisePath(p: string): string | null {
  const segments: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(seg);
  }
  return segments.join('/');
}

function stripTrailingSlash(p: string): string {
  if (p.length <= 1) return p;
  return p.endsWith('/') ? p.slice(0, -1) : p;
}

function parentDir(p: string): string {
  const trimmed = stripTrailingSlash(p);
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

function relativeFrom(base: string, full: string): string {
  const b = stripTrailingSlash(base);
  if (full === b) return '.';
  if (full.startsWith(`${b}/`)) return full.slice(b.length + 1);
  return full;
}
