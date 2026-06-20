/**
 * Scheduled tasks (#79) — declarative cron-driven agent runs.
 *
 * A scheduled task pairs a 5-field cron expression with a payload the agent
 * should run when the schedule fires. The production wiring is system cron:
 * `agent-do scheduled-tasks install` emits crontab lines that invoke
 * `agent-do scheduled-tasks run <id>` on schedule. `start` runs a foreground
 * loop for dev/testing. Either way, **executing a task acquires the #15 file
 * lock** so overlapping runs (cron fired before the previous run finished, or
 * two hosts sharing the same `--memory` dir) serialise rather than clobber.
 *
 * ## What's in v1
 *
 * - `ScheduledTask` type + `AgentConfig.scheduledTasks?: ScheduledTask[]`,
 *   validated at `createAgent()` time (unique ids, valid cron, non-empty
 *   payload).
 * - `matchesCron(expr, date)` — a correct, dependency-free 5-field matcher.
 * - `runScheduledTask()` — load the agent, take the lock, run the payload,
 *   record status. What crontab invokes.
 * - CLI: `scheduled-tasks run|list|status|start|install`.
 *
 * ## Deliberately deferred (noted in changeset)
 *
 * - `sessionTarget: 'main'` — appending to a persistent conversation needs a
 *   history store agent-do doesn't ship yet. v1 runs every task isolated.
 * - `wakeMode: 'systemEvent'` with a structured payload — there's no
 *   system-event channel yet; v1 treats the payload as the task text. String
 *   payloads work fully; structured objects are accepted but stringified.
 * - Cron niceties beyond the portable 5-field numeric subset (`L`/`W`/`#`,
 *   month/weekday names, `?`, seconds) — system cron varies by platform on
 *   these, so v1 sticks to what every cron supports.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { acquireFileLock } from './stores/file-lock.js';
import type { FileLockOptions } from './types.js';

/**
 * One scheduled task.
 *
 * `cron` is standard 5-field: minute hour day-of-month month day-of-week
 * (0-7, where 0 and 7 are Sunday). `payload` is the task text the agent runs.
 */
export interface ScheduledTask {
  /** Stable id. Used in `scheduled-tasks run <id>` and as the lock key. */
  id: string;
  /** 5-field cron expression. */
  cron: string;
  /** Task text (or stringifiable payload) the agent runs when the schedule fires. */
  payload: string | Record<string, unknown>;
  /** Human-readable description. Shown by `list` / `status`. */
  description?: string;
  /**
   * Reserved: `'isolated'` (v1 default — every run starts fresh) vs `'main'`
   * (append to a persistent conversation — deferred; needs a history store).
   */
  sessionTarget?: 'isolated' | 'main';
  /**
   * Reserved: `'agentTurn'` (v1 default — payload becomes the task text) vs
   * `'systemEvent'` (structured wake event — deferred; no event channel yet).
   */
  wakeMode?: 'agentTurn' | 'systemEvent';
}

export interface ScheduledTasksConfig {
  tasks: ScheduledTask[];
  /**
   * Where status (last-run times, outcomes) is recorded. Default
   * `<memoryDir>/scheduler-status.json`. The lock dir is `<memoryDir>/.locks`
   * so it reuses the #15 machinery and is shared across hosts.
   */
  statusFile?: string;
  /** Override the lock options (staleMs etc.) for overlap prevention. */
  lock?: FileLockOptions;
}

// ── Cron matcher ────────────────────────────────────────────────────────

const FIELDS = ['minute', 'hour', 'dom', 'month', 'dow'] as const;
type Field = (typeof FIELDS)[number];

const FIELD_RANGES: Record<Field, { min: number; max: number }> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dom: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dow: { min: 0, max: 7 }, // 0 and 7 both Sunday
};

/**
 * True iff `date` matches the 5-field cron expression `expr`.
 *
 * Throws on malformed expressions (unknown field, out-of-range value, bad
 * step, non-numeric token). Validation happens up front in `createAgent()`,
 * so a task that passed validation won't throw here — but the matcher is
 * exported and used directly by tests, so it validates defensively.
 *
 * Note on dom/dow interaction (the classic cron gotcha): per Vixie cron, if
 * BOTH dom and dow are restricted (not `*`), the date matches if EITHER
 * matches; if only one is restricted, that one must match. This matches the
 * behaviour of every system cron.
 */
export function matchesCron(expr: string, date: Date = new Date()): boolean {
  const fields = parseCron(expr);
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1; // JS months are 0-based
  // JS getDay(): 0=Sunday..6=Saturday. Cron dow: 0 and 7 = Sunday.
  const dow = date.getDay();

  if (!fields.minute.has(minute)) return false;
  if (!fields.hour.has(hour)) return false;
  if (!fields.month.has(month)) return false;

  const domStar = fields.dom.isStar;
  const dowStar = fields.dow.isStar;
  const domMatch = fields.dom.has(dom);
  // Normalise 7 → 0 so Sunday matches either spelling.
  const dowMatch = fields.dow.has(dow) || fields.dow.has(7) && dow === 0;

  if (domStar && dowStar) return true;
  if (domStar) return dowMatch;
  if (dowStar) return domMatch;
  return domMatch || dowMatch; // both restricted → OR (Vixie semantics)
}

interface ParsedField {
  has(n: number): boolean;
  readonly isStar: boolean;
}

function parseCron(expr: string): Record<Field, ParsedField> {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Invalid cron expression "${expr}": expected 5 fields (minute hour dom month dow), got ${parts.length}.`,
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return {
    minute: parseField(parts[0]!, 'minute'),
    hour: parseField(parts[1]!, 'hour'),
    dom: parseField(parts[2]!, 'dom'),
    month: parseField(parts[3]!, 'month'),
    dow: parseField(parts[4]!, 'dow'),
  };
}

function parseField(raw: string, field: Field): ParsedField {
  const { min, max } = FIELD_RANGES[field];
  const values = new Set<number>();
  let isStar = false;

  for (const item of raw.split(',')) {
    if (item === '*') {
      isStar = true;
      for (let n = min; n <= max; n++) values.add(normalize(n, field));
      continue;
    }
    // step: a-b/n, */n, or n/n
    const stepMatch = item.match(/^(.*)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2]!, 10) : 1;
    const rangePart = stepMatch ? stepMatch[1]! : item;
    if (step < 1) throw new Error(`Invalid cron step "${item}" in ${field}: step must be >= 1.`);

    let lo: number, hi: number;
    if (rangePart === '*') {
      lo = min; hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      if (a === undefined || b === undefined) {
        throw new Error(`Invalid cron range "${rangePart}" in ${field}.`);
      }
      lo = parseInt(a, 10); hi = parseInt(b, 10);
    } else {
      lo = parseInt(rangePart, 10);
      hi = lo; // single value → degenerate range [lo, lo]
    }
    if (Number.isNaN(lo) || Number.isNaN(hi)) {
      throw new Error(`Invalid cron value "${item}" in ${field}: not a number.`);
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(
        `Cron ${field} value out of range in "${item}": allowed ${min}-${max}.`,
      );
    }
    for (let n = lo; n <= hi; n += step) values.add(normalize(n, field));
  }

  return {
    has: (n: number) => values.has(normalize(n, field)),
    isStar,
  };
}

/** For dow, treat 7 as 0 (both Sunday). Other fields pass through. */
function normalize(n: number, field: Field): number {
  if (field === 'dow' && n === 7) return 0;
  return n;
}

// ── Validation ──────────────────────────────────────────────────────────

export function validateScheduledTasks(tasks: ScheduledTask[]): ScheduledTask[] {
  const ids = new Set<string>();
  for (const t of tasks) {
    if (!t.id || !/^[a-zA-Z0-9_-]+$/.test(t.id)) {
      throw new Error(`Scheduled task id "${t.id}" is invalid (use [a-zA-Z0-9_-]+).`);
    }
    if (ids.has(t.id)) {
      throw new Error(`Duplicate scheduled task id "${t.id}".`);
    }
    ids.add(t.id);
    // parseCron throws on malformed expressions — that's the validation.
    parseCron(t.cron);
    if (t.payload === undefined || t.payload === null) {
      throw new Error(`Scheduled task "${t.id}" has no payload.`);
    }
  }
  return tasks;
}

// ── Status tracking ─────────────────────────────────────────────────────

export interface TaskStatus {
  lastRunAt?: string; // ISO
  lastDurationMs?: number;
  lastOutcome?: 'ok' | 'error';
  lastError?: string;
  runCount: number;
}

export type StatusRecord = Record<string, TaskStatus>;

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
