/**
 * Filesystem side of scheduled tasks: status records and the locked run path - Node only.
 *
 * Divided from `scheduled-tasks.ts` because these functions need `node:fs/promises`, `node:path` and the
 * #15 file lock (which needs `node:os` and `node:crypto`), while the cron matcher and the config
 * validator are pure and must stay importable from a browser build (GH #139, agent-do-5ep). The division
 * follows the dependency: what remains in `scheduled-tasks.ts` is arithmetic on dates and validation of
 * config; what lives here talks to the host. Each function is still exported from `src/index.ts`, so the
 * native Node surface is unchanged.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { acquireFileLock } from '../stores/file-lock.js';
import type { FileLockOptions } from '../types.js';
import type { StatusRecord, TaskStatus } from '../scheduled-tasks.js';

export async function readStatus(statusFile: string): Promise<StatusRecord> {
  try {
    const raw = await readFile(statusFile, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as StatusRecord) : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

export async function writeStatus(statusFile: string, record: StatusRecord): Promise<void> {
  await mkdir(dirname(statusFile), { recursive: true });
  await writeFile(statusFile, JSON.stringify(record, null, 2), 'utf-8');
}

/** Record a completed run. Never throws — a status-write failure must not
 *  mask the run's own outcome. Returns the updated record. */
export async function recordRun(
  statusFile: string,
  taskId: string,
  outcome: { ok: boolean; durationMs: number; error?: string },
): Promise<TaskStatus> {
  const all = await readStatus(statusFile).catch(() => ({}) as StatusRecord);
  const prev = all[taskId] ?? { runCount: 0 };
  const next: TaskStatus = {
    ...prev,
    lastRunAt: new Date().toISOString(),
    lastDurationMs: outcome.durationMs,
    lastOutcome: outcome.ok ? 'ok' : 'error',
    lastError: outcome.ok ? undefined : (outcome.error ?? 'unknown error'),
    runCount: prev.runCount + 1,
  };
  all[taskId] = next;
  await writeStatus(statusFile, all).catch(() => { /* best-effort */ });
  return next;
}

// ── Overlap-safe execution ──────────────────────────────────────────────

/**
 * Run a single scheduled task under an exclusive lock, then record status.
 *
 * The lock key is the task id; the lock dir is `<memoryDir>/.locks` so it
 * reuses the #15 machinery and is shared across hosts mounting the same dir.
 * If the lock can't be acquired (a previous run is still going, or its lock
 * is fresher than `staleMs`), the run is skipped with outcome `{ skipped }`.
 *
 * `run` is the caller-supplied agent executor — typically the agent's
 * `.run(payloadText)`. Injected so this module stays free of agent-construction
 * concerns (and stays unit-testable with a mock).
 */
export async function runScheduledTask(
  taskId: string,
  opts: {
    memoryDir: string;
    statusFile: string;
    lock?: FileLockOptions;
    run: (payloadText: string) => Promise<string>;
    payload: string | Record<string, unknown>;
  },
): Promise<{ ok: boolean; skipped: boolean; error?: string; durationMs: number }> {
  const payloadText = typeof opts.payload === 'string'
    ? opts.payload
    : JSON.stringify(opts.payload);
  const lockDir = join(opts.memoryDir, '.locks');
  const started = Date.now();

  let handle;
  try {
    handle = await acquireFileLock(`scheduled-task:${taskId}`, 'scheduler', lockDir, {
      staleMs: 15 * 60_000, // a single agent turn shouldn't run 15 min; if it does, the next firing reclaims
      ...opts.lock,
    });
  } catch (err) {
    // Couldn't acquire — a previous run is still active (or its stale lock
    // hasn't aged out). Skip rather than pile on. Not an error outcome.
    const skipped = { ok: true, skipped: true, durationMs: Date.now() - started };
    await recordRun(opts.statusFile, taskId, { ok: true, durationMs: skipped.durationMs });
    return skipped;
  }

  try {
    await opts.run(payloadText);
    const durationMs = Date.now() - started;
    await recordRun(opts.statusFile, taskId, { ok: true, durationMs });
    return { ok: true, skipped: false, durationMs };
  } catch (err) {
    const durationMs = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    await recordRun(opts.statusFile, taskId, { ok: false, durationMs, error: message });
    return { ok: false, skipped: false, error: message, durationMs };
  } finally {
    await handle.release();
  }
}
