/**
 * FilesystemMemoryStore — Node.js filesystem-backed MemoryStore.
 *
 * Stores agent files in {baseDir}/{agentId}/ on the local filesystem.
 * Files persist across process restarts.
 *
 * Security options:
 * - `readOnly: true` blocks all write operations (zero write side effects)
 * - `onBeforeWrite` callback lets you approve/deny each write
 *
 * Usage:
 *   import { FilesystemMemoryStore } from 'agent-do/stores/filesystem';
 *
 *   // Basic (full read/write access):
 *   const store = new FilesystemMemoryStore('/path/to/data');
 *
 *   // Read-only (agent can read but not modify):
 *   const readOnlyStore = new FilesystemMemoryStore('/path/to/data', { readOnly: true });
 *
 *   // With write confirmation (receives canonicalized path):
 *   const guardedStore = new FilesystemMemoryStore('/path/to/data', {
 *     onBeforeWrite: async (agentId, canonicalPath, operation) => {
 *       console.log(`Agent ${agentId} wants to ${operation}: ${canonicalPath}`);
 *       return true; // or false to block
 *     },
 *   });
 *
 * Implementation note: every method uses `node:fs/promises` (no
 * `fs.*Sync` calls inside `async` functions). The original sync
 * variants blocked the Node event loop for the full duration of any
 * read or directory walk, which made the store unsafe for server /
 * concurrent contexts. See issue #25.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { MemoryStore, FileEntry } from '../stores.js';
import type { FilesystemMemoryStoreOptions } from '../types.js';

export type { FilesystemMemoryStoreOptions } from '../types.js';

export class FilesystemMemoryStore implements MemoryStore {
  private options: FilesystemMemoryStoreOptions;

  constructor(private baseDir: string, options?: FilesystemMemoryStoreOptions) {
    this.options = options || {};
    // The constructor stays synchronous because callers `new` the store
    // outside of an async context. mkdir is the only side effect, and
    // is gated on readOnly to keep that mode side-effect-free.
    if (!this.options.readOnly) {
      fs.mkdirSync(baseDir, { recursive: true });
    }
  }

  private resolve(agentId: string, filePath: string): string {
    const agentDir = path.resolve(this.baseDir, agentId);
    const resolved = path.resolve(agentDir, filePath);
    if (!resolved.startsWith(path.resolve(this.baseDir))) {
      throw new Error('Path traversal not allowed');
    }
    return resolved;
  }

  /** Returns the canonicalized relative path for use in callbacks. */
  private canonicalRelativePath(agentId: string, filePath: string): string {
    const resolved = this.resolve(agentId, filePath);
    const agentDir = path.resolve(this.baseDir, agentId);
    return path.relative(agentDir, resolved);
  }

  private async checkWrite(agentId: string, filePath: string, op: 'write' | 'append' | 'delete' | 'mkdir'): Promise<void> {
    if (this.options.readOnly) {
      throw new Error(`Write blocked: store is read-only (attempted ${op} on ${filePath})`);
    }
    if (this.options.onBeforeWrite) {
      // Pass the canonicalized path so policies can't be bypassed with ../
      const canonicalPath = this.canonicalRelativePath(agentId, filePath);
      const allowed = await Promise.resolve(this.options.onBeforeWrite(agentId, canonicalPath, op));
      if (!allowed) {
        throw new Error(`Write blocked by onBeforeWrite callback (attempted ${op} on ${canonicalPath})`);
      }
    }
  }

  async read(agentId: string, filePath: string): Promise<string> {
    const full = this.resolve(agentId, filePath);
    try {
      return await fsp.readFile(full, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`File not found: ${filePath}`);
      }
      throw err;
    }
  }

  async write(agentId: string, filePath: string, content: string): Promise<void> {
    await this.checkWrite(agentId, filePath, 'write');
    const full = this.resolve(agentId, filePath);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, content, 'utf-8');
  }

  async append(agentId: string, filePath: string, content: string): Promise<void> {
    await this.checkWrite(agentId, filePath, 'append');
    const full = this.resolve(agentId, filePath);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.appendFile(full, content, 'utf-8');
  }

  async delete(agentId: string, filePath: string): Promise<void> {
    await this.checkWrite(agentId, filePath, 'delete');
    const full = this.resolve(agentId, filePath);
    try {
      await fsp.unlink(full);
    } catch (err) {
      // Match the previous "no error if missing" behaviour so callers
      // can treat delete as idempotent.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async list(agentId: string, dirPath?: string): Promise<FileEntry[]> {
    const full = this.resolve(agentId, dirPath || '.');
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(full, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    // Stat each file in parallel — parallelism is bounded by the
    // single readdir call (typically dozens, not thousands), so a
    // simple Promise.all is the right shape here.
    return Promise.all(
      entries.map(async (e) => ({
        name: e.name,
        type: e.isDirectory() ? ('directory' as const) : ('file' as const),
        size: e.isFile()
          ? (await fsp.stat(path.join(full, e.name))).size
          : undefined,
      })),
    );
  }

  async mkdir(agentId: string, dirPath: string): Promise<void> {
    await this.checkWrite(agentId, dirPath, 'mkdir');
    await fsp.mkdir(this.resolve(agentId, dirPath), { recursive: true });
  }

  async exists(agentId: string, filePath: string): Promise<boolean> {
    try {
      await fsp.stat(this.resolve(agentId, filePath));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  async search(agentId: string, pattern: string, dirPath?: string): Promise<Array<{ path: string; line: string }>> {
    const results: Array<{ path: string; line: string }> = [];
    const searchDir = this.resolve(agentId, dirPath || '.');
    await this.searchRecursive(searchDir, this.resolve(agentId, '.'), pattern, results);
    return results;
  }

  private async searchRecursive(
    dir: string,
    baseDir: string,
    pattern: string,
    results: Array<{ path: string; line: string }>,
  ): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }

    for (const entry of entries) {
      if (results.length >= 100) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        await this.searchRecursive(full, baseDir, pattern, results);
        continue;
      }
      try {
        const content = await fsp.readFile(full, 'utf-8');
        const regex = new RegExp(pattern, 'gi');
        for (const line of content.split('\n')) {
          if (regex.test(line)) {
            results.push({ path: path.relative(baseDir, full), line: line.trim() });
            if (results.length >= 100) return;
          }
          regex.lastIndex = 0;
        }
      } catch {
        /* skip binary / unreadable files */
      }
    }
  }
}
