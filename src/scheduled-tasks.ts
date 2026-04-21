/**
 * Scheduled tasks (#79) — declarative cron-driven agent runs with
 * lock-file concurrency.
 *
 * This module is a primitive kit, not a daemon:
 *
 * 1. `validateScheduledTasks` — called from `createAgent` to fail loud
 *    on bad cron, duplicate IDs, or unsafe task IDs.
 * 2. `parseCron` / `cronMatches` — a minimal, dependency-free cron
 *    evaluator. Supports the standard star, numeric, range, list, and
 *    step forms (e.g. `N-M`, comma lists, step suffixes). Numeric
 *    fields only — named months / weekdays are not supported, to keep
 *    the surface small and the tests exhaustive.
 * 3. `acquireLock` / `releaseLock` — a PID-liveness-aware lock file.
 *    Stale locks (process dead) are broken automatically so a crashed
 *    run doesn't block the next one forever.
 * 4. `runScheduledTask` — fire one task now: acquire its lock, run the
 *    agent with the task's payload, record status, release the lock.
 * 5. `runScheduler` — a foreground loop that ticks once per minute
 *    and fires any task whose cron matches. Useful for development;
 *    production users will typically install a crontab entry per task.
 * 6. `generateCrontabEntries` — render a crontab block the user can
 *    paste into `crontab -e`. We deliberately don't touch the crontab
 *    directly; shell integration is the user's call.
 *
 * Design constraints mirrored from the rest of agent-do:
 *
 * - No heavy dependencies — cron evaluation is ~60 lines.
 * - Node.js-only (the module imports `node:fs` / `node:path`). The
 *   module is gated in `src/index.ts` behind the main export, so
 *   downstream bundlers can still tree-shake cleanly.
 * - Structured status records so `scheduled-tasks status` can render
 *   useful output without a second data source.
 *
 * See GitHub issue #79 for design rationale.
 */

import { promises as fsp } from 'node:fs';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Agent, ScheduledTask, ScheduledTaskStatus } from './types.js';

// ─── Validation ─────────────────────────────────────────────────────────

const TASK_ID_RE = /^[a-zA-Z0-9_-]+$/;
const TASK_ID_MAX_LENGTH = 64;

/**
 * Validate a list of {@link ScheduledTask} values. Throws on the first
 * problem encountered — misconfiguration should fail loud at
 * `createAgent` time, not on the first cron tick hours later.
 *
 * Checks:
 * - Each id is safe as a filename (`/^[a-zA-Z0-9_-]+$/`, ≤64 chars).
 * - IDs are unique within the config.
 * - `cron` parses cleanly.
 * - `wakeMode` / `sessionTarget` are known enum members.
 * - `payload` is a string or a plain object.
 */
export function validateScheduledTasks(tasks: ScheduledTask[]): void {
  if (!Array.isArray(tasks)) {
    throw new TypeError('scheduledTasks must be an array');
  }
  const seen = new Set<string>();
  for (const task of tasks) {
    if (!task || typeof task !== 'object') {
      throw new TypeError('Each scheduled task must be a { id, cron, payload, … } object');
    }
    if (typeof task.id !== 'string' || !TASK_ID_RE.test(task.id) || task.id.length > TASK_ID_MAX_LENGTH) {
      throw new Error(
        `Invalid scheduled task id: ${JSON.stringify(task.id)}. ` +
          `IDs must match /^[a-zA-Z0-9_-]+$/ and be ≤ ${TASK_ID_MAX_LENGTH} chars.`,
      );
    }
    if (seen.has(task.id)) {
      throw new Error(`Duplicate scheduled task id: ${task.id}`);
    }
    seen.add(task.id);
    if (typeof task.cron !== 'string' || task.cron.trim() === '') {
      throw new Error(`Scheduled task "${task.id}" is missing a cron expression`);
    }
    // Throws on invalid cron with a message pinpointing the field.
    parseCron(task.cron);
    if (task.sessionTarget !== undefined && task.sessionTarget !== 'isolated' && task.sessionTarget !== 'main') {
      throw new Error(
        `Scheduled task "${task.id}" has unknown sessionTarget ` +
          `${JSON.stringify(task.sessionTarget)} (expected 'isolated' or 'main')`,
      );
    }
    if (task.wakeMode !== undefined && task.wakeMode !== 'agentTurn' && task.wakeMode !== 'systemEvent') {
      throw new Error(
        `Scheduled task "${task.id}" has unknown wakeMode ` +
          `${JSON.stringify(task.wakeMode)} (expected 'agentTurn' or 'systemEvent')`,
      );
    }
    if (
      typeof task.payload !== 'string' &&
      (typeof task.payload !== 'object' || task.payload === null || Array.isArray(task.payload))
    ) {
      throw new Error(
        `Scheduled task "${task.id}" payload must be a string or a plain object`,
      );
    }
  }
}

// ─── Cron parser ────────────────────────────────────────────────────────

/** Inclusive range for each of the five cron fields. */
const CRON_FIELD_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 both == Sunday)
];
const CRON_FIELD_NAMES = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'] as const;

/**
 * A parsed cron expression — five sets of allowed integers, one per
 * field. `dayOfWeek` collapses `7` onto `0` so callers only need to
 * check Sunday once.
 */
export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /**
   * True when either day-of-month or day-of-week was restricted (not
   * `*`). Standard cron semantics OR the two when either is restricted;
   * we need to know which fields are restricted so {@link cronMatches}
   * can apply the OR correctly.
   */
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

/**
 * Parse a 5-field cron expression into a {@link ParsedCron}. Throws
 * with a field-specific message when any field is invalid.
 */
export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Invalid cron expression ${JSON.stringify(expr)}: ` +
        `expected 5 space-separated fields (min hour day-of-month month day-of-week), got ${fields.length}`,
    );
  }
  const parsed = fields.map((field, i) =>
    parseCronField(field, CRON_FIELD_RANGES[i]![0], CRON_FIELD_RANGES[i]![1], CRON_FIELD_NAMES[i]!),
  );
  const dayOfWeek = parsed[4]!;
  // Collapse 7 → 0 so Sunday is a single canonical value.
  if (dayOfWeek.has(7)) {
    dayOfWeek.delete(7);
    dayOfWeek.add(0);
  }
  return {
    minute: parsed[0]!,
    hour: parsed[1]!,
    dayOfMonth: parsed[2]!,
    month: parsed[3]!,
    dayOfWeek,
    dayOfMonthRestricted: fields[2] !== '*',
    dayOfWeekRestricted: fields[4] !== '*',
  };
}

function parseCronField(field: string, min: number, max: number, name: string): Set<number> {
  const out = new Set<number>();
  for (const piece of field.split(',')) {
    const trimmed = piece.trim();
    if (trimmed === '') {
      throw new Error(`Invalid cron ${name} field: empty entry in ${JSON.stringify(field)}`);
    }
    const [range, stepStr] = trimmed.split('/');
    const step = stepStr === undefined ? 1 : parseInt(stepStr, 10);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Invalid cron ${name} step ${JSON.stringify(stepStr)} in ${JSON.stringify(trimmed)}`);
    }
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range!.includes('-')) {
      const [loStr, hiStr] = range!.split('-');
      lo = parseInt(loStr!, 10);
      hi = parseInt(hiStr!, 10);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
        throw new Error(`Invalid cron ${name} range ${JSON.stringify(range)}`);
      }
      if (lo > hi) {
        throw new Error(
          `Invalid cron ${name} range ${JSON.stringify(range)}: low bound ${lo} > high bound ${hi}`,
        );
      }
    } else {
      const value = parseInt(range!, 10);
      if (!Number.isInteger(value)) {
        throw new Error(`Invalid cron ${name} value ${JSON.stringify(range)}`);
      }
      // A single numeric value combined with a step expands to [value, max].
      // e.g. `5/15` in the minute field means 5, 20, 35, 50.
      lo = value;
      hi = stepStr === undefined ? value : max;
    }
    if (lo < min || hi > max) {
      throw new Error(
        `Invalid cron ${name} range ${lo}-${hi}: must be within [${min}, ${max}]`,
      );
    }
    for (let n = lo; n <= hi; n += step) out.add(n);
  }
  if (out.size === 0) {
    throw new Error(`Cron ${name} field ${JSON.stringify(field)} matches no values`);
  }
  return out;
}

/**
 * True when the given `Date` falls within the cron expression. Follows
 * the standard "day-of-month OR day-of-week when either is restricted"
 * rule.
 */
export function cronMatches(parsed: ParsedCron, date: Date): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1; // JS months are 0-indexed
  const dow = date.getDay();
  if (!parsed.minute.has(minute)) return false;
  if (!parsed.hour.has(hour)) return false;
  if (!parsed.month.has(month)) return false;
  // Day-of-month OR day-of-week semantics:
  // - If both are unrestricted (`*`), match.
  // - If only one is restricted, it must match.
  // - If both are restricted, EITHER matching is enough (union).
  const domMatch = parsed.dayOfMonth.has(dom);
  const dowMatch = parsed.dayOfWeek.has(dow);
  if (!parsed.dayOfMonthRestricted && !parsed.dayOfWeekRestricted) return true;
  if (parsed.dayOfMonthRestricted && parsed.dayOfWeekRestricted) {
    return domMatch || dowMatch;
  }
  if (parsed.dayOfMonthRestricted) return domMatch;
  return dowMatch;
}

// ─── Lock files ─────────────────────────────────────────────────────────

/**
 * Shape of a lock-file record. `pid` is the OS process id that holds
 * the lock; `startedAt` is the ISO timestamp of when the lock was
 * acquired. `host` is included so locks created on a different machine
 * (e.g. shared NFS) aren't broken just because the current host's
 * `process.kill(pid, 0)` returns ESRCH.
 */
interface LockRecord {
  taskId: string;
  pid: number;
  host: string;
  startedAt: string;
}

/**
 * Guard lock-primitive callers against path traversal. `ScheduledTask`
 * IDs are already validated at `createAgent` time, but the low-level
 * `acquireLock` / `releaseLock` / `readLock` helpers are exported so
 * an unvalidated `taskId` (e.g. `../../etc/passwd`) mustn't be able to
 * escape `lockDir`. Defence in depth — we keep this even though
 * `validateScheduledTasks` should already catch bad IDs upstream.
 */
function assertValidTaskId(taskId: string): void {
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new TypeError('taskId must be a non-empty string');
  }
  if (taskId.length > TASK_ID_MAX_LENGTH || !TASK_ID_RE.test(taskId)) {
    throw new TypeError(
      `taskId must match ${TASK_ID_RE.toString()} and be ≤ ${TASK_ID_MAX_LENGTH} chars`,
    );
  }
}

function lockPath(lockDir: string, taskId: string): string {
  assertValidTaskId(taskId);
  return path.join(lockDir, `${taskId}.lock`);
}

/**
 * True when the given PID is alive on this host. `process.kill(pid, 0)`
 * is the canonical probe on POSIX and Windows; it throws ESRCH for dead
 * PIDs and EPERM when the PID exists but is owned by another user
 * (still alive, so we treat EPERM as "alive").
 */
function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

/**
 * Read a lock-file record. Returns `null` when the file is absent,
 * unreadable, or malformed. Callers treat `null` as "no usable lock
 * record"; malformed lock files are **not** automatically broken by
 * this reader — `acquireLock` is conservative and only breaks locks
 * it can positively identify as stale (same host, dead PID).
 */
export async function readLock(lockDir: string, taskId: string): Promise<LockRecord | null> {
  try {
    const raw = await fsp.readFile(lockPath(lockDir, taskId), 'utf8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.startedAt !== 'string'
    ) {
      return null;
    }
    return {
      taskId: typeof parsed.taskId === 'string' ? parsed.taskId : taskId,
      pid: parsed.pid,
      host: typeof parsed.host === 'string' ? parsed.host : '',
      startedAt: parsed.startedAt,
    };
  } catch {
    return null;
  }
}

/**
 * How many times `acquireLock` retries the stale-lock recovery dance
 * before giving up. The dance is: read the lock, confirm it's stale,
 * unlink it, try `open('wx')` again. Each unlink/open round can race
 * with another process doing the same thing on the same stale lock;
 * cap the retries so we don't spin forever if a never-ending stream
 * of processes keeps winning.
 */
const STALE_LOCK_RETRIES = 5;

/**
 * Attempt to acquire a lock for the given task. Returns `true` on
 * success, `false` when another live process already holds it (or a
 * foreign-host process, or a malformed lock we conservatively refuse
 * to break).
 *
 * The happy path uses `open(..., 'wx')` — atomic create-if-not-exists.
 * If the file already exists, we inspect it:
 *
 * - Foreign host → refuse (we can't probe remote liveness).
 * - Malformed / unreadable → refuse (can't prove it's stale).
 * - Same host, live PID → refuse (the lock is genuinely held).
 * - Same host, dead PID → **stale-lock recovery**: `unlink` + retry
 *   `open('wx')`. This is atomic wrt concurrent recoverers: two
 *   processes can both unlink, but only one `wx` wins — the loser
 *   sees EEXIST and re-reads the lock (now owned by the winner) and
 *   returns false.
 */
export async function acquireLock(lockDir: string, taskId: string): Promise<boolean> {
  // Validate up-front so a bad `taskId` fails loud instead of silently
  // no-op-ing downstream — even if the caller validated already.
  assertValidTaskId(taskId);
  await fsp.mkdir(lockDir, { recursive: true });
  const file = lockPath(lockDir, taskId);
  const body = () =>
    JSON.stringify(
      {
        taskId,
        pid: process.pid,
        host: hostName(),
        startedAt: new Date().toISOString(),
      } satisfies LockRecord,
      null,
      2,
    );

  for (let attempt = 0; attempt < STALE_LOCK_RETRIES; attempt++) {
    try {
      // 'wx' — fail if the file already exists. Atomic wrt concurrent
      // acquire attempts on the same host.
      const handle = await fsp.open(file, 'wx');
      try {
        await handle.writeFile(body(), 'utf8');
      } finally {
        await handle.close();
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    // Lock exists — is it recoverably stale?
    const existing = await readLock(lockDir, taskId);
    if (!existing) return false; // malformed → refuse
    if (existing.host !== hostName()) return false; // foreign host → refuse
    if (isPidAlive(existing.pid)) return false; // live holder → refuse
    // Stale local lock. Unlink then retry `wx`. If another process is
    // racing the same recovery, exactly one `wx` wins; the loser sees
    // EEXIST on the next iteration, re-reads the (now-fresh) lock,
    // finds a live PID (the winner), and returns false.
    try {
      await fsp.unlink(file);
    } catch (err) {
      // ENOENT means someone else already unlinked it — that's fine,
      // let the next `wx` attempt race for the new lock.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return false;
}

/** Release the lock for `taskId`. Idempotent — no-op if already gone. */
export async function releaseLock(lockDir: string, taskId: string): Promise<void> {
  assertValidTaskId(taskId);
  try {
    await fsp.unlink(lockPath(lockDir, taskId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function hostName(): string {
  try {
    return os.hostname();
  } catch {
    return '';
  }
}

// ─── Status file ────────────────────────────────────────────────────────

const STATUS_FILENAME = 'status.json';

function statusPath(lockDir: string): string {
  return path.join(lockDir, STATUS_FILENAME);
}

/**
 * Read the status map. Missing / malformed files return an empty map
 * — status is observational, not load-bearing.
 */
export async function readStatus(lockDir: string): Promise<Record<string, ScheduledTaskStatus>> {
  try {
    const raw = await fsp.readFile(statusPath(lockDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    // Drop prototype-pollution keys defensively.
    const out: Record<string, ScheduledTaskStatus> = Object.create(null);
    for (const [k, v] of Object.entries(parsed)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      if (typeof v === 'object' && v !== null) {
        out[k] = v as ScheduledTaskStatus;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Atomic write: render to a tempfile in the same directory, then
 * `rename` over the target. On POSIX `rename` is atomic within a
 * filesystem, so readers either see the old file or the new one —
 * never a half-written `status.json`. Crash safety: a dangling
 * tempfile is garbage but never corrupts the live file.
 */
async function atomicWriteJson(target: string, body: string): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, body, 'utf8');
  try {
    await fsp.rename(tmp, target);
  } catch (err) {
    // Best-effort tempfile cleanup on rename failure.
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Serialize status updates within a single process. `tickScheduler`
 * fires matching tasks in parallel, and each one does a
 * read-modify-write of the shared `status.json`. Without this
 * promise-chained mutex, two parallel `updateStatus` calls can both
 * read the old map, each overwrite the other's changes, and drop
 * counters. The per-`lockDir` keying lets multiple schedulers in the
 * same process (running against different dirs) update independently.
 *
 * Cross-process safety still relies on the per-task lock file —
 * two different processes updating the *same* task's status are
 * already serialised by the task lock. Cross-process status races on
 * *different* tasks hitting the same `status.json` simultaneously
 * could still lose a write, but status is observational: the next
 * run of either task rewrites its entry. The atomic rename above
 * means the file itself is never corrupt.
 */
const statusChains = new Map<string, Promise<void>>();

async function writeStatus(lockDir: string, map: Record<string, ScheduledTaskStatus>): Promise<void> {
  await fsp.mkdir(lockDir, { recursive: true });
  await atomicWriteJson(statusPath(lockDir), JSON.stringify(map, null, 2));
}

async function updateStatus(
  lockDir: string,
  taskId: string,
  patch: Partial<ScheduledTaskStatus>,
): Promise<void> {
  const prev = statusChains.get(lockDir) ?? Promise.resolve();
  const next = prev.then(async () => {
    const all = await readStatus(lockDir);
    const existing = all[taskId] ?? { id: taskId, successCount: 0, failureCount: 0 };
    all[taskId] = { ...existing, ...patch, id: taskId };
    await writeStatus(lockDir, all);
  });
  // Swallow downstream errors from the chain so one failed update
  // doesn't break every subsequent caller. `next` (as returned to the
  // caller) still rejects on its own failure.
  statusChains.set(
    lockDir,
    next.catch(() => {}),
  );
  return next;
}

// ─── Task runtime ───────────────────────────────────────────────────────

/**
 * Outcome of {@link runScheduledTask}. `'skipped'` means the lock was
 * already held by another live process — the scheduler will try again
 * on the next tick.
 */
export type ScheduledTaskRunOutcome =
  | { status: 'success'; output: string; durationMs: number }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string; durationMs: number };

export interface RunScheduledTaskOptions {
  /**
   * Directory used for lock / status files. Defaults to
   * `.agent-do/scheduler` under cwd.
   */
  lockDir?: string;
  /**
   * Swallow the agent error instead of rethrowing, so a single task's
   * failure doesn't take down the surrounding scheduler loop. Defaults
   * to `true` — the status file carries the error so an operator can
   * still see it.
   */
  swallowErrors?: boolean;
}

/**
 * Default lock / status directory. Kept relative to cwd so a stray
 * agent-do invocation in a different working tree gets its own locks
 * and doesn't trample another project's.
 */
export const DEFAULT_LOCK_DIR = path.join('.agent-do', 'scheduler');

/**
 * Build the prompt a single scheduled task sends to the agent.
 *
 * `agentTurn` — the payload (string, or object → JSON) is used as the
 * prompt verbatim, simulating a normal user message.
 *
 * `systemEvent` — the payload is wrapped in a `<system-event>` envelope
 * that tells the model it was woken by a scheduler tick rather than by
 * a human. Includes the "OK silence" hint from the issue: the model
 * should reply with `OK` when there's nothing to do.
 */
export function buildScheduledTaskPrompt(task: ScheduledTask): string {
  const payloadString =
    typeof task.payload === 'string' ? task.payload : JSON.stringify(task.payload, null, 2);
  const wakeMode = task.wakeMode ?? 'agentTurn';
  if (wakeMode === 'agentTurn') {
    return payloadString;
  }
  return (
    `<system-event task-id="${escapeAttr(task.id)}" cron="${escapeAttr(task.cron)}">\n` +
    `${payloadString}\n` +
    `</system-event>\n\n` +
    `This was a scheduled wake. If there is nothing to act on, reply with a single token \`OK\` — ` +
    `don't narrate the silence.`
  );
}

function escapeAttr(value: string): string {
  return value.replace(/["<>\n\r]/g, ' ').slice(0, 256);
}

/**
 * Execute a single scheduled task.
 *
 * Acquires the lock, runs the agent with a payload-derived prompt,
 * records status, and releases the lock. If the lock is already held
 * by a live process, returns `{ status: 'skipped' }` without touching
 * the agent — the contract with the caller is that concurrent runs of
 * the same task never overlap.
 */
export async function runScheduledTask(
  agent: Agent,
  task: ScheduledTask,
  options: RunScheduledTaskOptions = {},
): Promise<ScheduledTaskRunOutcome> {
  const lockDir = options.lockDir ?? DEFAULT_LOCK_DIR;
  const swallowErrors = options.swallowErrors ?? true;

  const acquired = await acquireLock(lockDir, task.id);
  if (!acquired) {
    const existing = await readLock(lockDir, task.id);
    const reason = existing
      ? `Task "${task.id}" lock held by pid ${existing.pid} on ${existing.host || 'unknown'} since ${existing.startedAt}`
      : `Task "${task.id}" lock is held`;
    await updateStatus(lockDir, task.id, { lastStatus: 'skipped' });
    return { status: 'skipped', reason };
  }

  const start = Date.now();
  const startIso = new Date(start).toISOString();
  await updateStatus(lockDir, task.id, { lastRun: startIso, lastStatus: 'running' });

  try {
    const prompt = buildScheduledTaskPrompt(task);
    const output = await agent.run(prompt);
    const durationMs = Date.now() - start;
    const prev = (await readStatus(lockDir))[task.id];
    await updateStatus(lockDir, task.id, {
      lastFinished: new Date().toISOString(),
      lastStatus: 'success',
      durationMs,
      lastError: undefined,
      successCount: (prev?.successCount ?? 0) + 1,
    });
    return { status: 'success', output, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    const prev = (await readStatus(lockDir))[task.id];
    await updateStatus(lockDir, task.id, {
      lastFinished: new Date().toISOString(),
      lastStatus: 'failed',
      durationMs,
      lastError: message,
      failureCount: (prev?.failureCount ?? 0) + 1,
    });
    if (!swallowErrors) throw err;
    return { status: 'failed', error: message, durationMs };
  } finally {
    await releaseLock(lockDir, task.id);
  }
}

// ─── Scheduler loop ─────────────────────────────────────────────────────

export interface RunSchedulerOptions {
  lockDir?: string;
  /**
   * Tick interval in ms. Defaults to 60_000 (one minute). Lowering
   * this is mostly useful for tests; cron's resolution is 1 minute.
   */
  tickMs?: number;
  /**
   * Called with each task outcome, for logging. Optional.
   */
  onOutcome?: (task: ScheduledTask, outcome: ScheduledTaskRunOutcome) => void;
  /**
   * Abort signal — when aborted, the loop exits after the current
   * tick finishes (so in-flight tasks complete cleanly).
   */
  signal?: AbortSignal;
  /**
   * Clock override, for tests. Must return the "current" Date.
   * Defaults to `() => new Date()`.
   */
  now?: () => Date;
}

/**
 * Scheduler state shared across ticks. Keeps the "last fired minute"
 * per task so a tick running twice within the same minute (possible
 * with a small `tickMs` for tests) doesn't double-fire.
 */
export interface SchedulerState {
  lastFiredMinute: Map<string, number>;
}

/** Allocate an empty {@link SchedulerState} — tests create one per loop. */
export function createSchedulerState(): SchedulerState {
  return { lastFiredMinute: new Map() };
}

/**
 * Evaluate the schedule once and fire any tasks whose cron matches the
 * given `date`. Exposed so tests can drive the scheduler tick-by-tick
 * without running a timer loop.
 *
 * Returns the outcomes from `runScheduledTask` for each fired task.
 */
export async function tickScheduler(
  agent: Agent,
  tasks: ReadonlyArray<{ task: ScheduledTask; cron: ParsedCron }>,
  state: SchedulerState,
  date: Date,
  options: { lockDir?: string; onOutcome?: (task: ScheduledTask, outcome: ScheduledTaskRunOutcome) => void } = {},
): Promise<ScheduledTaskRunOutcome[]> {
  const lockDir = options.lockDir ?? DEFAULT_LOCK_DIR;
  const minuteKey = Math.floor(date.getTime() / 60_000);
  const fires = tasks.filter(
    ({ task, cron }) => cronMatches(cron, date) && state.lastFiredMinute.get(task.id) !== minuteKey,
  );
  // Mark *before* awaiting so a slow previous tick can't cause the
  // same minute to fire twice.
  for (const { task } of fires) state.lastFiredMinute.set(task.id, minuteKey);
  return Promise.all(
    fires.map(async ({ task }) => {
      const outcome = await runScheduledTask(agent, task, { lockDir });
      options.onOutcome?.(task, outcome);
      return outcome;
    }),
  );
}

/**
 * Run the scheduler in the foreground.
 *
 * Every `tickMs` ms (default one minute), evaluates each task's cron
 * against the current minute and invokes any that match. Tasks run in
 * parallel within a tick — the per-task lock file prevents overlap
 * with a previous tick's still-running copy.
 */
export async function runScheduler(
  agent: Agent,
  tasks: ScheduledTask[],
  options: RunSchedulerOptions = {},
): Promise<void> {
  validateScheduledTasks(tasks);
  const tickMs = options.tickMs ?? 60_000;
  const now = options.now ?? (() => new Date());
  const parsed = tasks.map((t) => ({ task: t, cron: parseCron(t.cron) }));
  const state = createSchedulerState();

  while (!options.signal?.aborted) {
    await tickScheduler(agent, parsed, state, now(), {
      lockDir: options.lockDir,
      onOutcome: options.onOutcome,
    });
    if (options.signal?.aborted) break;
    await sleep(tickMs, options.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ─── Crontab install rendering ──────────────────────────────────────────

export interface GenerateCrontabOptions {
  /**
   * Path to the agent-do CLI binary. Defaults to `agent-do` — the
   * user's PATH is expected to resolve it. For dev setups, pass
   * `./node_modules/.bin/agent-do` or an absolute path.
   */
  cliPath?: string;
  /**
   * Directory the cron command should `cd` into before running the
   * task. Defaults to the current working directory — that's almost
   * always what the user wants because `.agent-do/` is project-local.
   */
  workingDir?: string;
  /**
   * Extra flags passed to `agent-do scheduled-tasks run <id>`. For
   * example, `['--script', './my-agent.ts', '--yes']` when the tasks
   * are defined in a script file.
   */
  extraArgs?: string[];
  /**
   * Directory into which per-task logs should be appended. Defaults
   * to `.agent-do/logs`.
   */
  logDir?: string;
}

/**
 * Render a crontab block that the user can paste into `crontab -e`.
 *
 * Each line:
 * ```
 * <cron> cd <workingDir> && <cliPath> scheduled-tasks run <id> [extraArgs] >> <logDir>/<id>.log 2>&1
 * ```
 *
 * We emit a block of lines rather than writing the crontab directly —
 * modifying the user's crontab is a side effect too risky for a
 * library primitive to take on its own. The CLI wraps this with a
 * "review these lines and paste them yourself" message.
 */
export function generateCrontabEntries(
  tasks: ScheduledTask[],
  options: GenerateCrontabOptions = {},
): string {
  validateScheduledTasks(tasks);
  const cliPath = options.cliPath ?? 'agent-do';
  const workingDir = options.workingDir ?? process.cwd();
  const logDir = options.logDir ?? path.join('.agent-do', 'logs');
  const extra = (options.extraArgs ?? []).map(shellQuote).join(' ');
  const suffix = extra ? ' ' + extra : '';
  const lines: string[] = [
    '# agent-do scheduled tasks — generated by `scheduled-tasks install`',
    '# Review these lines before pasting into `crontab -e`.',
  ];
  for (const task of tasks) {
    const logFile = path.posix.join(logDir, `${task.id}.log`);
    const desc = task.description ? ` # ${task.description.replace(/\r?\n/g, ' ')}` : '';
    lines.push(
      `${task.cron} cd ${shellQuote(workingDir)} && ${shellQuote(cliPath)} scheduled-tasks run ${shellQuote(task.id)}${suffix} >> ${shellQuote(logFile)} 2>&1${desc}`,
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * Minimal POSIX shell quoting. We avoid double-quoting because that
 * would re-interpret `$` and backticks in paths; single quotes are
 * safe as long as the value doesn't contain a single quote itself,
 * which we handle by escaping.
 */
function shellQuote(value: string): string {
  if (value === '') return "''";
  if (/^[a-zA-Z0-9_\-./]+$/.test(value)) return value;
  return "'" + value.replace(/'/g, `'\\''`) + "'";
}

// ─── Helpers exported for tests / CLI ───────────────────────────────────

/** True when `.agent-do/scheduler/<taskId>.lock` exists on disk. */
export function hasLockFile(lockDir: string, taskId: string): boolean {
  return existsSync(lockPath(lockDir, taskId));
}
