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
import type { MemoryStore, FileEntry, SearchOptions } from '../stores.js';
import type { FilesystemMemoryStoreOptions } from '../types.js';

/**
 * Hard cap on the regex pattern length. 256 chars is comfortably more
 * than enough for realistic search patterns and tightly limits the
 * combinatoric blast radius of an LLM-supplied catastrophic regex.
 */
const MAX_REGEX_PATTERN_LENGTH = 256;

/**
 * Conservative heuristic for catastrophic-backtracking patterns. Detects
 * the canonical "nested quantifier" shape `(...[+*]...)[+*]` that
 * causes exponential time on adversarial inputs. Not exhaustive — a
 * truly hostile regex can still slip through — but covers the common
 * ReDoS patterns flagged by `safe-regex2` without adding a dependency.
 */
const NESTED_QUANTIFIER_RE = /\([^)]*[+*][^)]*\)[+*?]/;

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

  async search(
    agentId: string,
    pattern: string,
    dirPath?: string,
    options?: SearchOptions,
  ): Promise<Array<{ path: string; line: string }>> {
    // Build the matcher once. Default is a literal substring search;
    // regex mode is opt-in and goes through a safety check that bounds
    // pattern length and rejects obvious catastrophic-backtracking
    // shapes. See `SearchOptions` and issue #21.
    const matcher = buildLineMatcher(pattern, options?.regex === true);
    const results: Array<{ path: string; line: string }> = [];
    const searchDir = this.resolve(agentId, dirPath || '.');
    this.searchRecursive(searchDir, this.resolve(agentId, '.'), matcher, results);
    return results;
  }

  private searchRecursive(
    dir: string, baseDir: string, matcher: (line: string) => boolean,
    results: Array<{ path: string; line: string }>,
  ): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') {
          this.searchRecursive(full, baseDir, matcher, results);
        }
      } else {
        try {
          const content = fs.readFileSync(full, 'utf-8');
          for (const line of content.split('\n')) {
            if (matcher(line)) {
              results.push({ path: path.relative(baseDir, full), line: line.trim() });
              if (results.length >= 100) return;
            }
          }
        } catch { /* skip binary files */ }
      }
    }
  }
}

/**
 * Build a per-line matcher closure for {@link FilesystemMemoryStore.search}.
 *
 * - Literal mode (default): case-insensitive substring match. No
 *   compilation, no backtracking, no surface area for ReDoS.
 * - Regex mode: case-insensitive regex with a length cap and a
 *   nested-quantifier heuristic that rejects the most common
 *   catastrophic shapes before they ever run.
 *
 * Throws on rejected input rather than silently returning no matches —
 * the caller (the `grep_file` tool wrapper) catches the throw and
 * surfaces it to the model as an error message.
 */
function buildLineMatcher(
  pattern: string,
  asRegex: boolean,
): (line: string) => boolean {
  if (!asRegex) {
    const needle = pattern.toLowerCase();
    return (line) => line.toLowerCase().includes(needle);
  }
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    throw new Error(
      `Regex pattern too long (${pattern.length} > ${MAX_REGEX_PATTERN_LENGTH} chars).`,
    );
  }
  if (NESTED_QUANTIFIER_RE.test(pattern)) {
    throw new Error(
      'Regex pattern rejected: contains a nested quantifier (e.g. "(a+)+") ' +
      'that can cause catastrophic backtracking. Rewrite without nested ' +
      'quantifiers, or use literal mode (omit `regex: true`).',
    );
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'gi');
  } catch (err) {
    throw new Error(
      `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return (line) => {
    re.lastIndex = 0;
    return re.test(line);
  };
}
