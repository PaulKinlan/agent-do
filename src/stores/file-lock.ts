/**
 * Zero-dependency cross-process file lock for `FilesystemMemoryStore` (#15 Tier 1).
 *
 * Same-process mutexes (`async-lock` and friends) only serialise within one
 * Node process; they offer zero protection against the orchestrator's worker
 * runs, separate `agent.run()` invocations, or cron-spawned processes (#79).
 * This module provides a **filesystem** lock that is visible across every
 * process that shares the same `baseDir` — the only kind of lock that works
 * for scheduled / multi-process agents.
 *
 * Mechanism:
 *  - `O_CREAT | O_EXCL` (atomic "create-if-absent"). One of the few
 *    operations the POSIX spec guarantees atomic across local AND network
 *    filesystems (NFS, EFS). The loser of the race gets EEXIST.
 *  - **mtime-based stale reclaim**: a lock whose mtime is older than
 *    `staleMs` is presumed abandoned (the holder crashed, was OOM-killed,
 *    or the machine rebooted). We unlink + recreate. This is essential for
 *    #79 — a scheduled job killed mid-write must leave a reclaimable lock.
 *  - **retry/backoff** on contention: a process that loses the race waits
 *    and retries up to `retry.count` times.
 *
 * Lock files live in `<baseDir>/.locks/<agentId>/<sha256>.lock`, keyed on
 * the canonical resolved path so every process locking the same file agrees
 * on the lock path. They are intentionally outside the agent's own dir so
 * `list()` / `search()` / `read()` never surface bookkeeping.
 *
 * ## Limitations (documented)
 *
 * POSIX locks are **advisory**: a process that writes without acquiring the
 * lock (e.g. an editor, a direct `fs.writeFile`, or a store instance created
 * without the `lock` option) can still clobber a locked file. This matches
 * `proper-lockfile` and every Node file-lock library. For hard isolation
 * you'd need a sandboxed FS (#98) or a DB-backed store (#15 Tier 2).
 *
 * mtime granularity is 1s on some filesystems (ext3, older HFS+); for
 * sub-second contention windows two holders can briefly believe a live lock
 * is stale. The stale threshold defaults to 60s to make this vanishingly
 * unlikely in practice; cron/orchestrator cadences are far coarser.
 *
 * Reads are intentionally NOT locked (see the #15 research brief): a read
 * during a write could see a half-flushed file. Pair this lock with the
 * store's atomic temp-write+rename so readers see either the old or the new
 * file, never a partial one.
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { type FileLockOptions, type LockHandle } from '../types.js';

/** Default staleness threshold. Generous on purpose — see mtime caveat above. */
const DEFAULT_STALE_MS = 60_000;

/** Default contention backoff. */
const DEFAULT_RETRY = { count: 20, minDelayMs: 25, maxDelayMs: 1000 };

export interface FileLockOptionsInternal extends FileLockOptions {}

/**
 * Acquire an exclusive lock for `keyPath`, waiting/retrying on contention
 * and reclaiming stale locks left by crashed holders.
 *
 * `keyPath` is the **canonical absolute path of the file being protected**
 * (what `FilesystemMemoryStore.resolve()` returns). The actual lock file is
 * derived from it deterministically via a SHA-256 of that path, so two
 * processes that resolve the same logical file to the same canonical path
 * share one lock file — even across machines that mount the same volume.
 *
 * `lockDirRoot` is the `<baseDir>/.locks` directory; the per-agent subdir
 * is created under it.
 *
 * Returns a `LockHandle` whose `release()` removes the lock file. Best-effort:
 * release never throws (ENOENT is ignored — the lock was already reclaimed).
 *
 * Throws when the lock can't be acquired within `retry.count` attempts.
 */
export async function acquireFileLock(
  keyPath: string,
  agentId: string,
  lockDirRoot: string,
  opts: FileLockOptions = {},
): Promise<LockHandle> {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const retry = { ...DEFAULT_RETRY, ...opts.retry };
  const lockFile = lockPathFor(keyPath, agentId, lockDirRoot);

  await fsp.mkdir(path.dirname(lockFile), { recursive: true });

  let attempt = 0;
  // Use the adapter if one was provided (proper-lockfile / fs-ext / a mock);
  // otherwise the built-in zero-dep sidecar implementation.
  if (opts.adapter) {
    return opts.adapter.acquire(lockFile, { staleMs, retry });
  }

  const payload = lockPayload();
  for (;;) {
    try {
      // 'wx' = O_CREAT | O_EXCL | O_WRONLY as a single flag string. Atomic
      // across local AND network filesystems (NFS/EFS) per POSIX. fsp.open
      // with the pipe-separated string ('O_CREAT | O_EXCL | O_WRONLY') is NOT
      // accepted — it must be the symbolic flag name.
      const fh = await fsp.open(lockFile, 'wx');
      await fh.writeFile(payload);
      await fh.close();
      return makeHandle(lockFile);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      // Lost the race. Is the existing lock stale?
      if (await isStale(lockFile, staleMs)) {
        // Try to reclaim: unlink then loop back to the O_EXCL create.
        // If another process reclaimed first, our create fails EEXIST
        // again and we fall through to the retry/backoff below.
        await fsp.unlink(lockFile).catch(() => { /* race: already gone */ });
        continue;
      }
    }
    if (++attempt > retry.count) {
      throw new Error(
        `Could not acquire file lock after ${retry.count} attempts: ${lockFile}. ` +
        `Another process may be stuck; raise \`lock.staleMs\` (currently ${staleMs}ms) ` +
        `or remove the lock file manually.`,
      );
    }
    await sleep(backoffDelay(attempt, retry.minDelayMs, retry.maxDelayMs));
  }
}

/**
 * Convenience: acquire, run `fn`, release (even on throw). Returns `fn`'s
 * result. The release happens in a `finally`, so a throwing critical section
 * never leaks a lock.
 */
export async function withFileLock<T>(
  keyPath: string,
  agentId: string,
  lockDirRoot: string,
  opts: FileLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const handle = await acquireFileLock(keyPath, agentId, lockDirRoot, opts);
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}

/**
 * Derive a deterministic, traversal-safe lock file path for a data file.
 *
 * Hashing (rather than embedding the path) means a weird data path can never
 * escape the `.locks/<agentId>/` dir via `..`, and the filename is always
 * filesystem-safe regardless of the original path's characters. The first 16
 * hex chars are appended in plain text purely for human readability when
 * debugging a stuck lock (`ls .locks/agent/`).
 */
function lockPathFor(keyPath: string, agentId: string, lockDirRoot: string): string {
  const hash = createHash('sha256').update(keyPath).digest('hex');
  // Validate agentId defensively even though the store already validates it;
  // this module is exported and could be called directly.
  if (!/^[a-zA-Z0-9_.-]+$/.test(agentId)) {
    throw new Error(`Invalid agentId for lock dir: ${agentId}`);
  }
  return path.join(lockDirRoot, agentId, `${hash.slice(0, 16)}.lock`);
}

/** JSON payload written into the lock file. PID/host are for debugging only. */
function lockPayload(): string {
  return JSON.stringify({
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: Date.now(),
  });
}

/**
 * True iff the lock file at `p` has not been touched within `staleMs`.
 *
 * Uses mtime rather than the payload's `acquiredAt`: mtime is updated by the
 * filesystem and can't lie about a process that crashed before it could write
 * a heartbeat. (proper-lockfile uses an mtime heartbeat for the same reason.)
 * Throws other fs errors up — a permissions issue on the lock dir is a real
 * problem, not a "the lock is stale" signal.
 */
async function isStale(lockFile: string, staleMs: number): Promise<boolean> {
  let st: { mtimeMs: number };
  try {
    st = await fsp.stat(lockFile);
  } catch (err) {
    // Vanished between our EEXIST and the stat — another process reclaimed
    // and released already. Treat as "not stale" so the caller retries the
    // create; it'll either succeed (file gone) or EEXIST again.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  return Date.now() - st.mtimeMs > staleMs;
}

function makeHandle(lockFile: string): LockHandle {
  return {
    async release(): Promise<void> {
      // Best-effort. The lock may already be gone if this process stalled
      // past staleMs and another holder reclaimed + released it.
      await fsp.unlink(lockFile).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err;
      });
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential-ish backoff with jitter, capped at maxDelayMs. Keeps contended
 * writers from thundering onto the lock in lockstep.
 */
function backoffDelay(attempt: number, minDelayMs: number, maxDelayMs: number): number {
  const base = Math.min(maxDelayMs, minDelayMs * 2 ** (attempt - 1));
  // Jitter ±25% so N waiters don't retry in unison.
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}
