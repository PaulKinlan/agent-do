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
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MemoryStore, FileEntry } from '../stores.js';
import type { FilesystemMemoryStoreOptions } from '../types.js';
import { validateAgentId } from './agent-id.js';

export type { FilesystemMemoryStoreOptions } from '../types.js';

export class FilesystemMemoryStore implements MemoryStore {
  private options: FilesystemMemoryStoreOptions;

  constructor(private baseDir: string, options?: FilesystemMemoryStoreOptions) {
    this.options = options || {};
    // Only create the base directory if not in read-only mode
    // so readOnly has zero write side effects
    if (!this.options.readOnly) {
      fs.mkdirSync(baseDir, { recursive: true });
    }
  }

  /**
   * Resolve an agent-relative path to an absolute filesystem path,
   * with four distinct guards (#20 H-01 + PR #64 review follow-ups):
   *
   * 1. **Agent-id validation** (#30). `validateAgentId` rejects
   *    traversal-shaped ids like `../other-tenant` before any path
   *    construction.
   *
   * 2. **Canonical-to-canonical containment.** Both the base dir and
   *    the resolved target are canonicalised via `realpathSafe`
   *    *before* the prefix check. Earlier drafts compared a raw
   *    `path.resolve(baseDir)` against a realpathed target, so a
   *    baseDir that was itself a symlink (e.g. `/Volumes/tmp` on
   *    macOS) made every legitimate path fail the check. Both sides
   *    of the comparison now go through the same canonicalisation.
   *
   * 3. **Per-agent isolation** (PR #64 Copilot). `filePath` is
   *    resolved against *agentDir*, and the containment check uses
   *    agentDir — not just baseDir — as the boundary. Without this,
   *    agentId=`a1` with filePath=`../a2/secret` resolved to a path
   *    inside baseDir but outside a1's own directory, leaking
   *    cross-tenant data.
   *
   * 4. **Root-path safety.** `withinBase` uses `path.relative` rather
   *    than a naive `startsWith(base + path.sep)`, because when base
   *    is `/` or a Windows drive root the `sep` concatenation turns
   *    into `//` / `C:\\` and rejects legitimate children.
   */
  private resolve(agentId: string, filePath: string): string {
    validateAgentId(agentId);
    // Canonicalise base up front so every later comparison is
    // canonical-vs-canonical. If baseDir is itself a symlink the
    // realpath walk resolves to the target; without this the
    // `withinBase(canonical, base)` check would reject every path.
    const base = realpathSafe(path.resolve(this.baseDir));
    const agentDir = realpathSafe(path.resolve(base, agentId));
    if (!withinBase(agentDir, base)) {
      throw new Error('Path traversal not allowed (agentId)');
    }
    const resolved = path.resolve(agentDir, filePath);
    // Agent-level isolation: the resolved path must stay inside the
    // agent's own directory. Checking `base` alone would permit
    // `filePath = "../other-agent/secret"`.
    if (!withinBase(resolved, agentDir)) {
      throw new Error('Path traversal not allowed');
    }
    const canonical = realpathSafe(resolved);
    if (!withinBase(canonical, agentDir)) {
      throw new Error('Path traversal via symlink not allowed');
    }
    return canonical;
  }

  /** Returns the canonicalized relative path for use in callbacks. */
  private canonicalRelativePath(agentId: string, filePath: string): string {
    const resolved = this.resolve(agentId, filePath);
    // Use the canonical agentDir (matching `resolve()`'s own
    // canonicalisation) so the relative path has no spurious `..`
    // segments when baseDir or agentDir contain symlinks.
    const base = realpathSafe(path.resolve(this.baseDir));
    const agentDir = realpathSafe(path.resolve(base, agentId));
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

  // (search) ───────────────────────────────────────────────────────
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

/**
 * True iff `candidate` is the same as, or strictly inside, `base`.
 *
 * Uses `path.relative` rather than a naive `startsWith(base + sep)`
 * so:
 *   - a sibling whose name shares the base prefix (`/data/agent` vs
 *     `/data/agent-evil`) is still rejected — the relative path
 *     starts with `..` and we bail;
 *   - a base that is a filesystem root (`/` on POSIX, `C:\` on
 *     Windows) is handled correctly — the naive `base + sep`
 *     concatenation would become `//` / `C:\\` and reject every
 *     legitimate child.
 *
 * Both inputs must already be absolute.
 */
function withinBase(candidate: string, base: string): boolean {
  if (candidate === base) return true;
  const rel = path.relative(base, candidate);
  // rel starting with `..` means the candidate is *above* or
  // alongside base. rel being an absolute path means the inputs are
  // on different roots (Windows drive letters). Either way it's not
  // inside base.
  if (rel === '' || rel === '.') return true;
  if (rel.startsWith('..')) return false;
  return !path.isAbsolute(rel);
}

/**
 * `fs.realpathSync(path)` requires the path to exist. For a fresh
 * write, the leaf doesn't exist yet — realpath would throw. Walk up
 * to the deepest existing ancestor, canonicalise that, and re-append
 * the unresolved suffix so we still detect symlinks anywhere in the
 * existing portion of the path.
 *
 * Returns the input unchanged if the deepest ancestor doesn't exist
 * (e.g. baseDir itself is missing) — the caller's containment check
 * is still authoritative.
 */
function realpathSafe(p: string): string {
  let suffix = '';
  let current = p;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return p;
    suffix = path.join(path.basename(current), suffix);
    current = parent;
  }
  let canonical: string;
  try {
    canonical = fs.realpathSync(current);
  } catch {
    return p;
  }
  return suffix ? path.join(canonical, suffix) : canonical;
}
