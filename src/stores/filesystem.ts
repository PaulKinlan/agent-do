/**
 * FilesystemMemoryStore — Node.js filesystem-backed MemoryStore.
 *
 * Stores agent files in {baseDir}/{agentId}/ on the local filesystem.
 * Files persist across process restarts.
 *
 * Security options:
 * - `readOnly: true` blocks all write operations
 * - `onBeforeWrite` callback lets you approve/deny each write
 *
 * Usage:
 *   import { FilesystemMemoryStore } from 'agent-do/stores/filesystem';
 *
 *   // Basic (full read/write access):
 *   const store = new FilesystemMemoryStore('/path/to/data');
 *
 *   // Read-only (agent can read but not modify):
 *   const store = new FilesystemMemoryStore('/path/to/data', { readOnly: true });
 *
 *   // With write confirmation:
 *   const store = new FilesystemMemoryStore('/path/to/data', {
 *     onBeforeWrite: async (agentId, path) => {
 *       return confirm(`Allow write to ${path}?`);
 *     },
 *   });
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MemoryStore, FileEntry } from '../stores.js';

export interface FilesystemMemoryStoreOptions {
  /** Block all write operations. Agent can only read existing files. */
  readOnly?: boolean;
  /**
   * Called before any write/append/delete/mkdir operation.
   * Return true to allow, false to block.
   * If not provided, all writes are allowed (unless readOnly is true).
   */
  onBeforeWrite?: (agentId: string, filePath: string, operation: 'write' | 'append' | 'delete' | 'mkdir') => Promise<boolean>;
}

export class FilesystemMemoryStore implements MemoryStore {
  private options: FilesystemMemoryStoreOptions;

  constructor(private baseDir: string, options?: FilesystemMemoryStoreOptions) {
    this.options = options || {};
    fs.mkdirSync(baseDir, { recursive: true });
  }

  private resolve(agentId: string, filePath: string): string {
    const agentDir = path.resolve(this.baseDir, agentId);
    const resolved = path.resolve(agentDir, filePath);
    if (!resolved.startsWith(path.resolve(this.baseDir))) {
      throw new Error('Path traversal not allowed');
    }
    return resolved;
  }

  private async checkWrite(agentId: string, filePath: string, op: 'write' | 'append' | 'delete' | 'mkdir'): Promise<void> {
    if (this.options.readOnly) {
      throw new Error(`Write blocked: store is read-only (attempted ${op} on ${filePath})`);
    }
    if (this.options.onBeforeWrite) {
      const allowed = await this.options.onBeforeWrite(agentId, filePath, op);
      if (!allowed) {
        throw new Error(`Write blocked by onBeforeWrite callback (attempted ${op} on ${filePath})`);
      }
    }
  }

  async read(agentId: string, filePath: string): Promise<string> {
    const full = this.resolve(agentId, filePath);
    if (!fs.existsSync(full)) throw new Error(`File not found: ${filePath}`);
    return fs.readFileSync(full, 'utf-8');
  }

  async write(agentId: string, filePath: string, content: string): Promise<void> {
    await this.checkWrite(agentId, filePath, 'write');
    const full = this.resolve(agentId, filePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
  }

  async append(agentId: string, filePath: string, content: string): Promise<void> {
    await this.checkWrite(agentId, filePath, 'append');
    const full = this.resolve(agentId, filePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.appendFileSync(full, content, 'utf-8');
  }

  async delete(agentId: string, filePath: string): Promise<void> {
    await this.checkWrite(agentId, filePath, 'delete');
    const full = this.resolve(agentId, filePath);
    if (fs.existsSync(full)) fs.unlinkSync(full);
  }

  async list(agentId: string, dirPath?: string): Promise<FileEntry[]> {
    const full = this.resolve(agentId, dirPath || '.');
    if (!fs.existsSync(full)) return [];
    return fs.readdirSync(full, { withFileTypes: true }).map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' as const : 'file' as const,
      size: e.isFile() ? fs.statSync(path.join(full, e.name)).size : undefined,
    }));
  }

  async mkdir(agentId: string, dirPath: string): Promise<void> {
    await this.checkWrite(agentId, dirPath, 'mkdir');
    fs.mkdirSync(this.resolve(agentId, dirPath), { recursive: true });
  }

  async exists(agentId: string, filePath: string): Promise<boolean> {
    return fs.existsSync(this.resolve(agentId, filePath));
  }

  async search(agentId: string, pattern: string, dirPath?: string): Promise<Array<{ path: string; line: string }>> {
    const results: Array<{ path: string; line: string }> = [];
    const searchDir = this.resolve(agentId, dirPath || '.');
    this.searchRecursive(searchDir, this.resolve(agentId, '.'), pattern, results);
    return results;
  }

  private searchRecursive(
    dir: string, baseDir: string, pattern: string,
    results: Array<{ path: string; line: string }>,
  ): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') {
          this.searchRecursive(full, baseDir, pattern, results);
        }
      } else {
        try {
          const content = fs.readFileSync(full, 'utf-8');
          const regex = new RegExp(pattern, 'gi');
          for (const line of content.split('\n')) {
            if (regex.test(line)) {
              results.push({ path: path.relative(baseDir, full), line: line.trim() });
              if (results.length >= 100) return;
            }
            regex.lastIndex = 0;
          }
        } catch { /* skip binary files */ }
      }
    }
  }
}
