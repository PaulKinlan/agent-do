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
 * `ok: false` means "refuse this path". A caller must never fall back to the
 * input, which is how every bypass in this area worked: an unattested path was
 * handed back unchanged, and the deny list then judged an innocent-looking name.
 * `reason` is the rule the deny list reports. Every cause maps to the same rule
 * because from a caller's view they are equivalent - in all of them we do not
 * know which file the I/O would reach.
 */
export type ResolvedPath = { ok: true; path: string } | { ok: false; reason: 'unresolved-path' };

const UNRESOLVED: ResolvedPath = { ok: false, reason: 'unresolved-path' };

/**
 * The one place that decides whether a filesystem error means "this component is
 * not there yet, so the walk can step past it" or "I cannot tell where this path
 * goes, so refuse".
 *
 * ONLY ENOENT is `absent`. Everything else - EACCES, EPERM, ELOOP, EIO, ENOTDIR,
 * a connector's own thrown value, a thrown non-Error - is `unattestable`, even
 * where a platform might consider it benign. Being strict is what makes the
 * invariant hold, and refusing a path is always safe.
 *
 * This exists because six of the seven findings in this area were one sentence:
 * a catch swallowed a failure it could not classify and the walk continued as if
 * the component had been attested. There are no bare catches in the resolver for
 * that reason - each one either classifies or refuses.
 */
function classifyError(err: unknown): 'absent' | 'unattestable' {
  // Checked inline rather than via isNotFoundError, which also treats ENOTDIR as
  // absent for the store's own "File not found" messages. Here that would be
  // wrong: "there is a file where a directory belongs" still says nothing about
  // what a symlink above it pointed at, so it is unattested.
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ENOENT' ? 'absent' : 'unattestable';
}

/**
 * `sandbox.realpath()` requires the path to exist (matching Node's
 * `fs.realpath`). This walks up to the deepest existing ancestor, canonicalises
 * that, and re-appends the unresolved remainder - so a fresh write is judged as
 * the file it would land on.
 *
 * THE INVARIANT: `ok: true` iff every component of the returned path was
 * positively attested - canonicalised by `realpath`, or observed not to be a
 * symlink, or observed to be a symlink whose target was read and followed within
 * budget. Every other outcome is `ok: false`. Nothing here returns a path it
 * could not attest, so a deny list never judges an alias instead of a file.
 *
 * Two bounds are kept deliberately apart: walking up to the nearest existing
 * ancestor is bounded only by the path's own depth (it terminates at the root),
 * while expanding symlinks needs its own budget, because a chain or a cycle can
 * be arbitrarily long. Counting them together was a bypass in itself
 * (agent-do-qhn): more missing levels than the budget exhausted it before
 * reaching the link, and exhaustion then returned the input unchanged.
 *
 * `stat()` is lstat semantics on this contract, so a connector can *see* a
 * symlink without being able to follow it. That is unattested, not harmless: a
 * link we can identify but not read is refused (agent-do-ajs, agent-do-vn9).
 *
 * A connector with neither `realpath` nor `readlink` reports "nothing to
 * resolve" by getting its input back; as the contract states, omitting both
 * declares that the substrate has no symlinks. The store's own normalisation is
 * authoritative there.
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
    // Concatenate then normalise, which is what node:path.posix does - a
    // segment that is itself absolute does not reset the prefix, it just
    // contributes its own empty leading component. `tests/path-resolution.test.ts`
    // checks all four of these against node:path.posix, because hand-rolled
    // arithmetic is exactly where these edge cases live.
    const joined = [base, ...parts].filter((part) => part !== '').join('/');
    const absolute = joined.startsWith('/');
    const segments: string[] = [];
    for (const segment of joined.split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') {
        if (segments.length && segments[segments.length - 1] !== '..') segments.pop();
        else if (!absolute) segments.push('..');
        continue;
      }
      segments.push(segment);
    }
    const body = segments.join('/');
    return absolute ? `/${body}` : body || '.';
  },
  dirname(p) {
    if (p === '/') return '/';
    const s = stripTrailingSlash(p);
    const i = s.lastIndexOf('/');
    if (i < 0) return '.';
    return i === 0 ? '/' : s.slice(0, i);
  },
  relative(from, to) {
    const split = (p: string) => p.split('/').filter((s) => s && s !== '.');
    const f = split(from);
    const t = split(to);
    let i = 0;
    while (i < f.length && i < t.length && f[i] === t[i]) i += 1;
    const parts = [...Array(f.length - i).fill('..'), ...t.slice(i)];
    return parts.join('/'); // node:path.posix.relative returns '' for equal paths
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
  // There is deliberately no capability shortcut here. A connector without
  // `realpath` can still *report* a symlink - just-bash does, via `[ -L ]` in its
  // stat - so the walk runs either way and the presence of a primitive decides
  // only how the walk ends, never whether it happens. Short-circuiting on
  // `!realpath` handed an alias back unchanged for exactly such a connector, and
  // `alias -> .env` leaked (agent-do-34f).
  const canRealpath = typeof sandbox.realpath === 'function';
  let parts: string[] = [];
  let current = p;
  let hops = 0;
  for (;;) {
    // 1. Does this path exist? If so, realpath is a positive attestation.
    if (canRealpath) {
      let canonical: string | undefined;
      let absent = false;
      try {
        canonical = await sandbox.realpath!(current);
      } catch (err) {
        if (classifyError(err) === 'unattestable') return UNRESOLVED;
        absent = true;
      }
      if (!absent) {
        if (typeof canonical !== 'string') return UNRESOLVED; // a connector that does not answer in strings
        return { ok: true, path: parts.length ? pathApi.join(canonical, ...parts) : canonical };
      }
    }

    // 2. Inspect this component before stepping past it. realpath reports ENOENT
    // for a symlink whose target is missing, exactly as if the link were absent,
    // so a link's own name survives into the answer without this (agent-do-5ww).
    let isLink = false;
    try {
      isLink = (await sandbox.stat(current)).isSymbolicLink;
    } catch (err) {
      // An error we cannot classify means we do not know what is here.
      if (classifyError(err) === 'unattestable') return UNRESOLVED;
    }

    // 3. Follow it. A link identified but not readable is unattested: judging
    // the link's own name is precisely the bypass (agent-do-vn9).
    if (isLink) {
      if (!sandbox.readlink) return UNRESOLVED;
      hops += 1;
      if (hops > MAX_SYMLINK_HOPS) return UNRESOLVED;
      let link: string;
      try {
        link = await sandbox.readlink(current);
      } catch {
        // Unconditional on purpose: whatever the failure is, a link whose target
        // cannot be read leaves the path unattested, so there is nothing to
        // classify and no branch that continues.
        return UNRESOLVED;
      }
      if (typeof link !== 'string') return UNRESOLVED;
      const target = pathApi.isAbsolute(link)
        ? link
        : pathApi.join(pathApi.dirname(current), link);
      current = parts.length ? pathApi.join(target, ...parts) : target;
      parts = [];
      continue;
    }

    // 4. Not a link, and not there: step towards the root.
    const parent = pathApi.dirname(current);
    if (parent === current) {
      // Reaching the root means every component was inspected and none was an
      // unresolved link. With a canonicaliser this only happens when the root
      // itself did not resolve, which is unattested. Without one, this is the
      // answer: the path rebuilt from the components that were walked.
      if (canRealpath) return UNRESOLVED;
      return { ok: true, path: parts.length ? pathApi.join(current, ...parts) : current };
    }
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
