import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  matchesCron,
  validateScheduledTasks,
  readStatus,
  writeStatus,
  recordRun,
  runScheduledTask,
} from '../src/scheduled-tasks.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── matchesCron: the correctness-critical part ─────────────────────────

describe('matchesCron — basic field matching', () => {
  // Helper: build a Date at a known wall-clock time so tests are deterministic.
  const at = (
    year: number, month: number, day: number,
    hour: number, minute: number,
  ): Date => new Date(year, month - 1, day, hour, minute);

  it('matches every minute with * * * * *', () => {
    const expr = '* * * * *';
    expect(matchesCron(expr, at(2026, 6, 19, 9, 30))).toBe(true);
    expect(matchesCron(expr, at(2026, 1, 1, 0, 0))).toBe(true);
    expect(matchesCron(expr, at(2026, 12, 31, 23, 59))).toBe(true);
  });

  it('matches an exact minute and hour', () => {
    const expr = '30 9 * * *'; // 9:30 every day
    expect(matchesCron(expr, at(2026, 6, 19, 9, 30))).toBe(true);
    expect(matchesCron(expr, at(2026, 6, 19, 9, 31))).toBe(false);
    expect(matchesCron(expr, at(2026, 6, 19, 10, 30))).toBe(false);
  });

  it('matches step values */15', () => {
    const expr = '*/15 * * * *';
    expect(matchesCron(expr, at(2026, 6, 19, 9, 0))).toBe(true);
    expect(matchesCron(expr, at(2026, 6, 19, 9, 15))).toBe(true);
    expect(matchesCron(expr, at(2026, 6, 19, 9, 30))).toBe(true);
    expect(matchesCron(expr, at(2026, 6, 19, 9, 45))).toBe(true);
    expect(matchesCron(expr, at(2026, 6, 19, 9, 7))).toBe(false);
    expect(matchesCron(expr, at(2026, 6, 19, 9, 59))).toBe(false);
  });

  it('matches a comma list', () => {
    const expr = '0,15,30,45 * * * *';
    expect(matchesCron(expr, at(2026, 6, 19, 9, 0))).toBe(true);
    expect(matchesCron(expr, at(2026, 6, 19, 9, 15))).toBe(true);
    expect(matchesCron(expr, at(2026, 6, 19, 9, 30))).toBe(true);
    expect(matchesCron(expr, at(2026, 6, 19, 9, 45))).toBe(true);
    expect(matchesCron(expr, at(2026, 6, 19, 9, 20))).toBe(false);
  });

  it('matches a range', () => {
    const expr = '0 9-17 * * *'; // top of every hour 9am..5pm
    for (let h = 0; h < 24; h++) {
      const m = matchesCron(expr, at(2026, 6, 19, h, 0));
      expect(m).toBe(h >= 9 && h <= 17);
    }
  });

  it('matches a stepped range', () => {
    const expr = '0 9-17/2 * * *'; // every 2 hours from 9..17
    expect(matchesCron(expr, at(2026, 6, 19, 9, 0))).toBe(true);
    expect(matchesCron(expr, at(2026, 6, 19, 11, 0))).toBe(true);
    expect(matchesCron(expr, at(2026, 6, 19, 13, 0))).toBe(true);
    expect(matchesCron(expr, at(2026, 6, 19, 15, 0))).toBe(true);
    expect(matchesCron(expr, at(2026, 6, 19, 17, 0))).toBe(true);
    expect(matchesCron(expr, at(2026, 6, 19, 10, 0))).toBe(false);
    expect(matchesCron(expr, at(2026, 6, 19, 16, 0))).toBe(false);
  });

  it('matches day-of-week (0 and 7 both Sunday)', () => {
    // 2026-06-21 is a Sunday.
    expect(matchesCron('0 0 * * 0', at(2026, 6, 21, 0, 0))).toBe(true);
    expect(matchesCron('0 0 * * 7', at(2026, 6, 21, 0, 0))).toBe(true);
    // 2026-06-22 is Monday.
    expect(matchesCron('0 0 * * 1', at(2026, 6, 22, 0, 0))).toBe(true);
    expect(matchesCron('0 0 * * 0', at(2026, 6, 22, 0, 0))).toBe(false);
  });

  it('matches month and day-of-month together', () => {
    const expr = '0 0 1 1 *'; // Jan 1 00:00
    expect(matchesCron(expr, at(2026, 1, 1, 0, 0))).toBe(true);
    expect(matchesCron(expr, at(2026, 1, 2, 0, 0))).toBe(false);
    expect(matchesCron(expr, at(2026, 2, 1, 0, 0))).toBe(false);
  });
});

describe('matchesCron — dom/dow OR semantics (Vixie cron)', () => {
  const at = (y: number, mo: number, d: number, h = 0, mi = 0): Date => new Date(y, mo - 1, d, h, mi);

  it('when both dom and dow are restricted, matches if EITHER matches', () => {
    // 2026-06-19 is a Friday (dow=5); dom=19.
    // Run on the 1st of the month OR on Sundays.
    const expr = '0 0 1 * 0';
    expect(matchesCron(expr, at(2026, 6, 1, 0, 0))).toBe(true);   // dom=1 → match
    expect(matchesCron(expr, at(2026, 6, 21, 0, 0))).toBe(true);  // Sunday → match
    expect(matchesCron(expr, at(2026, 6, 19, 0, 0))).toBe(false); // neither
  });

  it('when only dom is restricted (dow is *), dow is ignored', () => {
    const expr = '0 0 15 * *';
    expect(matchesCron(expr, at(2026, 6, 15, 0, 0))).toBe(true);
    expect(matchesCron(expr, at(2026, 6, 16, 0, 0))).toBe(false);
  });
});

describe('matchesCron — validation', () => {
  it('rejects expressions that are not 5 fields', () => {
    expect(() => matchesCron('* * * *')).toThrow(/expected 5 fields/);
    expect(() => matchesCron('* * * * * *')).toThrow(/expected 5 fields/);
  });

  it('rejects out-of-range values', () => {
    expect(() => matchesCron('60 * * * *')).toThrow(/out of range/); // minute 60
    expect(() => matchesCron('* 24 * * *')).toThrow(/out of range/); // hour 24
    expect(() => matchesCron('* * 32 * *')).toThrow(/out of range/); // dom 32
    expect(() => matchesCron('* * 0 * *')).toThrow(/out of range/);  // dom 0
    expect(() => matchesCron('* * * 13 *')).toThrow(/out of range/); // month 13
    expect(() => matchesCron('* * * * 8')).toThrow(/out of range/);  // dow 8 (max is 7)
  });

  it('rejects malformed tokens', () => {
    expect(() => matchesCron('abc * * * *')).toThrow();
    expect(() => matchesCron('*/0 * * * *')).toThrow(/step/);
    expect(() => matchesCron('1- * * * *')).toThrow();
  });
});

// ── validateScheduledTasks ─────────────────────────────────────────────

describe('validateScheduledTasks', () => {
  it('accepts a well-formed task list', () => {
    const tasks = validateScheduledTasks([
      { id: 'sweep', cron: '*/15 * * * *', payload: 'triage inbox' },
      { id: 'daily', cron: '0 2 * * *', payload: { event: 'daily' } },
    ]);
    expect(tasks).toHaveLength(2);
  });

  it('rejects duplicate ids', () => {
    expect(() =>
      validateScheduledTasks([
        { id: 'x', cron: '* * * * *', payload: 'a' },
        { id: 'x', cron: '* * * * *', payload: 'b' },
      ]),
    ).toThrow(/Duplicate scheduled task id "x"/);
  });

  it('rejects a bad id', () => {
    expect(() =>
      validateScheduledTasks([{ id: 'bad id!', cron: '* * * * *', payload: 'a' }]),
    ).toThrow(/invalid/);
  });

  it('rejects a bad cron', () => {
    expect(() =>
      validateScheduledTasks([{ id: 'ok', cron: '* * *', payload: 'a' }]),
    ).toThrow(/expected 5 fields/);
  });
});

// ── status read/write ──────────────────────────────────────────────────

describe('status tracking', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'sched-status-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('returns an empty record when no status file exists', async () => {
    const sf = join(dir, 'status.json');
    expect(await readStatus(sf)).toEqual({});
  });

  it('round-trips a written record', async () => {
    const sf = join(dir, 'sub', 'status.json'); // nested dir auto-created
    await writeStatus(sf, { sweep: { runCount: 3 } });
    expect(await readStatus(sf)).toEqual({ sweep: { runCount: 3 } });
  });

  it('recordRun increments count and stamps last-run metadata', async () => {
    const sf = join(dir, 'status.json');
    const r1 = await recordRun(sf, 't', { ok: true, durationMs: 100 });
    expect(r1.runCount).toBe(1);
    expect(r1.lastOutcome).toBe('ok');
    const r2 = await recordRun(sf, 't', { ok: false, durationMs: 200, error: 'boom' });
    expect(r2.runCount).toBe(2);
    expect(r2.lastOutcome).toBe('error');
    expect(r2.lastError).toBe('boom');
  });
});

// ── runScheduledTask (overlap-safe execution) ──────────────────────────

describe('runScheduledTask', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'sched-run-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('runs the payload and records an ok outcome', async () => {
    const sf = join(dir, 'status.json');
    let calledWith: string | null = null;
    const res = await runScheduledTask('sweep', {
      memoryDir: dir,
      statusFile: sf,
      run: async (p) => { calledWith = p; return 'done'; },
      payload: 'triage the inbox',
    });
    expect(res.ok).toBe(true);
    expect(res.skipped).toBe(false);
    expect(calledWith).toBe('triage the inbox');
    const status = await readStatus(sf);
    expect(status.sweep?.runCount).toBe(1);
    expect(status.sweep?.lastOutcome).toBe('ok');
  });

  it('stringifies a structured payload', async () => {
    const sf = join(dir, 'status.json');
    let calledWith = '';
    await runScheduledTask('evt', {
      memoryDir: dir, statusFile: sf,
      run: async (p) => { calledWith = p; return ''; },
      payload: { event: 'daily-prep' },
    });
    expect(JSON.parse(calledWith)).toEqual({ event: 'daily-prep' });
  });

  it('records an error outcome and still releases the lock', async () => {
    const sf = join(dir, 'status.json');
    const res = await runScheduledTask('bad', {
      memoryDir: dir, statusFile: sf,
      run: async () => { throw new Error('agent exploded'); },
      payload: 'x',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('agent exploded');
    const status = await readStatus(sf);
    expect(status.bad?.lastOutcome).toBe('error');
    // Lock released → a second run can acquire it immediately.
    const res2 = await runScheduledTask('bad', {
      memoryDir: dir, statusFile: sf,
      run: async () => 'ok', payload: 'x',
    });
    expect(res2.ok).toBe(true);
    expect(status.bad?.runCount).toBe(1); // (read before the 2nd run; check fresh below)
    expect((await readStatus(sf)).bad?.runCount).toBe(2);
  });

  it('skips (does not run) when the lock is held by an active run', async () => {
    const sf = join(dir, 'status.json');
    // Hold the lock externally for the same task key, then try to run.
    const { acquireFileLock } = await import('../src/stores/file-lock.js');
    const holder = await acquireFileLock('scheduled-task:sweep', 'scheduler', join(dir, '.locks'));
    let ran = false;
    const res = await runScheduledTask('sweep', {
      memoryDir: dir, statusFile: sf,
      run: async () => { ran = true; return ''; },
      payload: 'x',
      lock: { staleMs: 60_000, retry: { count: 2, minDelayMs: 1, maxDelayMs: 2 } },
    });
    expect(res.skipped).toBe(true);
    expect(ran).toBe(false);
    await holder.release();
  });
});
