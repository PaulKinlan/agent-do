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
 *   (host fs for the host connector, virtual fs for just-bash, VM fs
 *   for any future remote connectors).
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

  /**
   * Compute the on-substrate path for `(agentId, filePath)` and verify
   * it stays inside the agent's directory after symlinks are resolved.
   *
   * Two layers of protection:
   *
   * 1. **String-level normalisation.** `..` segments are folded out
   *    and an attempt to outpace the leading segments rejects with
   *    "Path traversal not allowed". Cheap, runs always.
   *
   * 2. **Canonical containment.** If the connector exposes
   *    {@link SandboxApi.realpath}, we resolve both the agent root and
   *    the requested path to canonical form (walking up to the deepest
   *    existing ancestor for not-yet-created paths) and verify the
   *    canonical path is still inside the canonical agent root. This
   *    is what keeps a `link → ../other-tenant` symlink from letting
   *    one agent write into another's directory.
   *
   * Connectors that don't expose `realpath` (e.g. just-bash's virtual
   * fs has no symlinks) skip step 2 — the string check is sufficient
   * for substrates without symlinks.
   */
  private async resolve(agentId: string, filePath: string): Promise<string> {
    validateAgentId(agentId);
    const normalised = normalisePath(filePath || '.');
    if (normalised === null) {
      throw new Error('Path traversal not allowed');
    }
    const base = stripTrailingSlash(this.root) || '/';
    const agentSegment = agentId ? `/${agentId}` : '';
    const joined = normalised === '' || normalised === '.'
      ? (`${base}${agentSegment}` || '/')
      : `${base}${agentSegment}/${normalised}`;

    if (!this.sandbox.realpath) return joined;

    const agentRoot = `${base}${agentSegment}` || '/';
    const resolvedRoot = await realpathSafe(this.sandbox, agentRoot, POSIX_PATH_API);
    const resolved = await realpathSafe(this.sandbox, joined, POSIX_PATH_API);
    if (!resolvedRoot.ok || !resolved.ok) {
      // The resolver could not attest the path - a symlink chain longer than the
      // bound, a cycle, or an error it cannot classify. Refusing is the only
      // safe answer: falling back to the uncanonicalised path is a bypass
      // (agent-do-qhn).
      throw new Error('Path traversal via symlink not allowed');
    }
    if (!withinPath(resolved.path, resolvedRoot.path)) {
      throw new Error('Path traversal via symlink not allowed');
    }
    return resolved.path;
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
    const full = await this.resolve(agentId, filePath);
    try {
      return await this.sandbox.readFile(full);
    } catch (err) {
      // Only normalise "not found" shapes to the cross-store
      // `File not found:` contract — anything else (permissions,
      // connector errors, decoding) bubbles up so the caller can
      // distinguish real failures from a missing path.
      if (isNotFoundError(err)) {
        throw new Error(`File not found: ${filePath}`, { cause: err });
      }
      throw err;
    }
  }

  async write(agentId: string, filePath: string, content: string): Promise<void> {
    await this.checkWrite(agentId, filePath, 'write');
    const full = await this.resolve(agentId, filePath);
    const parent = parentDir(full);
    if (parent && parent !== '/' && parent !== full) {
      await this.sandbox.mkdir(parent, { recursive: true });
    }
    await this.sandbox.writeFile(full, content);
  }

  /**
   * Append content to a file. Implemented as read-existing + write
   * (concatenated), which is **O(n) in the existing file size** and
   * has no concurrency guarantee — interleaved appends from different
   * callers can race. Acceptable for an agent's scratch logs (small,
   * single-writer); not appropriate for high-volume append workloads.
   *
   * The {@link SandboxApi} contract intentionally lacks an append
   * primitive (Flue parity); a future capability extension could add
   * one and have specific connectors override this method. For now,
   * use a connector-side append (e.g. `exec('cat >> …')`) if you need
   * better behaviour.
   */
  async append(agentId: string, filePath: string, content: string): Promise<void> {
    await this.checkWrite(agentId, filePath, 'append');
    const full = await this.resolve(agentId, filePath);
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
    const full = await this.resolve(agentId, filePath);
    try {
      await this.sandbox.rm(full, { force: true });
    } catch (err) {
      // Idempotent only for "missing" errors (matches
      // FilesystemMemoryStore). Permission / connector failures must
      // propagate — silently swallowing them tells the caller the
      // delete succeeded when the file is still on disk.
      if (isNotFoundError(err)) return;
      throw err;
    }
  }

  async list(agentId: string, dirPath?: string): Promise<FileEntry[]> {
    const full = await this.resolve(agentId, dirPath ?? '.');
    let names: string[];
    try {
      names = await this.sandbox.readdir(full);
    } catch (err) {
      // Only swallow "missing path" — let permission/connector errors
      // surface so they're not silently masked as an empty directory.
      if (isNotFoundError(err)) return [];
      throw err;
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
    const full = await this.resolve(agentId, dirPath);
    await this.sandbox.mkdir(full, { recursive: true });
  }

  async exists(agentId: string, filePath: string): Promise<boolean> {
    try {
      const full = await this.resolve(agentId, filePath);
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
    const root = await this.resolve(agentId, dirPath ?? '.');
    const agentRoot = await this.resolve(agentId, '.');
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

/**
 * `sandbox.realpath()` requires the path to exist (matching Node's
 * `fs.realpath`). For a fresh write the leaf doesn't exist yet, so
 * walk up to the deepest existing ancestor, canonicalise that, and
 * re-append the unresolved suffix. This still detects symlinks
 * anywhere in the existing portion of the path — which is what
 * matters for the containment check in
 * {@link SandboxBackedMemoryStore.resolve}.
 *
 * Returns the input unchanged if no ancestor exists or `realpath` is
 * undefined; the caller's containment check is still authoritative.
 */
/** How many symlink expansions a single resolution may take before giving up. */
const MAX_SYMLINK_HOPS = 32;

/**
 * A resolved path, or the reason the resolver could not attest one.
 *
 * The `ok: false` case exists so that a caller can never mistake "could not
 * resolve" for "resolved to something harmless": returning the input unchanged
 * is what made the earlier bypasses work, because a deny list then judged the
 * alias rather than the file the I/O would touch.
 */
export type ResolvedPath = { ok: true; path: string } | { ok: false; reason: 'symlink-chain' };

/**
 * `sandbox.realpath()` requires the path to exist (matching Node's
 * `fs.realpath`). This walks up to the deepest existing ancestor, canonicalises
 * that, and re-appends the unresolved remainder — so a fresh write is judged as
 * the file it would land on.
 *
 * Two different bounds are kept deliberately apart:
 *
 *  - walking up to the nearest existing ancestor is bounded only by the path's
 *    own depth, terminating at the root;
 *  - expanding a symlink needs its own budget, because a chain (or a cycle) can
 *    be arbitrarily long.
 *
 * Counting them together was a bypass in its own right (agent-do-qhn): a path
 * with more missing directory levels than the budget exhausted it *before*
 * reaching the symlink, and exhaustion returned the input unchanged — permitted.
 * So exhaustion now fails closed, and so does any error that leaves the path
 * unattested. `ResolvedPath.ok === false` means the caller must refuse.
 *
 * A symlink whose target does not exist yet is followed through `stat()` (lstat
 * semantics on this contract) and `readlink()`, which is what closes
 * agent-do-5ww. A substrate offering neither `realpath` nor `readlink` reports
 * "no symlinks to resolve" by returning the input, as the contract states, and
 * the caller's own containment check remains authoritative.
 */
export interface PathApi {
  join(base: string, ...parts: string[]): string;
  dirname(p: string): string;
  relative(from: string, to: string): string;
  isAbsolute(p: string): boolean;
}

/**
 * POSIX path arithmetic for a connector's namespace, which the contract defines
 * as connector-relative and POSIX-shaped. Callers resolving *host* paths pass
 * `node:path` instead, so this module needs no Node import of its own.
 */
export const POSIX_PATH_API: PathApi = {
  join(base, ...parts) {
    let out = stripTrailingSlash(base);
    for (const part of parts) {
      if (!part) continue;
      out = out === '' ? part : `${out}/${part}`;
    }
    return out === '' ? '/' : out;
  },
  dirname: parentDir,
  relative(from, to) {
    const f = stripTrailingSlash(from);
    const t = stripTrailingSlash(to);
    if (t === f) return '.';
    return t.startsWith(`${f}/`) ? t.slice(f.length + 1) : t;
  },
  isAbsolute(p) {
    return p.startsWith('/');
  },
};

export async function realpathSafe(
  sandbox: SandboxApi,
  p: string,
  pathApi: PathApi,
): Promise<ResolvedPath> {
  if (!sandbox.realpath) return { ok: true, path: p };
  let parts: string[] = [];
  let current = p;
  let hops = 0;
  for (;;) {
    try {
      const canonical = await sandbox.realpath(current);
      return { ok: true, path: parts.length ? pathApi.join(canonical, ...parts) : canonical };
    } catch (err) {
      if (!isNotFoundError(err)) {
        // The path exists but cannot be resolved (EACCES, ELOOP, a connector
        // error). Handing it back uncanonicalised would let a deny list judge
        // the wrong name, so refuse instead.
        return { ok: false, reason: 'symlink-chain' };
      }
    }

    // realpath cannot report a symlink whose target is missing: it fails with
    // ENOENT for the link, exactly as if it were absent. Inspect the component
    // before walking past it, or the link's own name survives into the answer.
    // `stat()` is lstat semantics on this contract, so a symlink is detectable
    // even by a connector that cannot read one. If the entry is a symlink and the
    // substrate cannot report its target, the path cannot be attested - refuse,
    // rather than fall through and let the caller judge the link's own name
    // (the fail-open shape all of agent-do-qhn's predecessors shared). A
    // substrate with no symlinks reports isSymbolicLink false and never reaches
    // this, which is why the contract may leave `readlink` optional.
    try {
      const stat = await sandbox.stat(current);
      if (stat.isSymbolicLink) {
        if (!sandbox.readlink) return { ok: false, reason: 'symlink-chain' };
        hops += 1;
        if (hops > MAX_SYMLINK_HOPS) return { ok: false, reason: 'symlink-chain' };
        const link = await sandbox.readlink(current);
        const target = pathApi.isAbsolute(link)
          ? link
          : pathApi.join(pathApi.dirname(current), link);
        current = parts.length ? pathApi.join(target, ...parts) : target;
        parts = [];
        continue;
      }
    } catch {
      // Genuinely absent, or a substrate whose stat cannot see it: walk up.
    }

    const parent = pathApi.dirname(current);
    if (parent === current) return { ok: true, path: p }; // reached the root
    parts.unshift(pathApi.relative(parent, current));
    current = parent;
  }
}

/**
 * True iff `candidate` is the same as, or strictly inside, `base`.
 * Both inputs must already be canonical (passed through `realpath`).
 */
function withinPath(candidate: string, base: string): boolean {
  const c = stripTrailingSlash(candidate);
  const b = stripTrailingSlash(base);
  if (c === b) return true;
  return c.startsWith(`${b}/`);
}

/**
 * Best-effort detection of a "missing path" error across connector
 * implementations. The {@link SandboxApi} contract doesn't dictate an
 * error shape (Flue's spec is intentionally loose), so we accept:
 *
 *   - Node.js `ENOENT` / `ENOTDIR` codes (host connector).
 *   - Error messages containing those tokens (most connectors that
 *     re-wrap a Node error).
 *   - Connector errors that just embed "not found" in the message.
 *
 * Anything else is treated as a real failure and propagated.
 */
function isNotFoundError(err: unknown): boolean {
  if (!err) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /ENOENT|ENOTDIR|no such file|not found/i.test(msg);
}
