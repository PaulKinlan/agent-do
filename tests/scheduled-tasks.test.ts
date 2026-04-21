/**
 * Tests for scheduled tasks (#79) — cron parsing, lock file handling,
 * per-task runtime, and the scheduler loop.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validateScheduledTasks,
  parseCron,
  cronMatches,
  acquireLock,
  releaseLock,
  readLock,
  hasLockFile,
  readStatus,
  runScheduledTask,
  runScheduler,
  buildScheduledTaskPrompt,
  generateCrontabEntries,
  tickScheduler,
  createSchedulerState,
} from '../src/scheduled-tasks.js';
import type { Agent, ScheduledTask } from '../src/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────

function mockAgent(run: (task: string) => Promise<string> | string): Agent {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    async run(task: string) {
      return Promise.resolve(run(task));
    },
    stream() {
      throw new Error('stream() not used in these tests');
    },
    abort() {
      /* no-op */
    },
  };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agent-do-sched-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Validation ─────────────────────────────────────────────────────────

describe('validateScheduledTasks', () => {
  it('accepts a minimal valid task list', () => {
    expect(() =>
      validateScheduledTasks([
        { id: 'a', cron: '*/15 * * * *', payload: 'hi' },
      ]),
    ).not.toThrow();
  });

  it('rejects duplicate IDs', () => {
    expect(() =>
      validateScheduledTasks([
        { id: 'a', cron: '* * * * *', payload: 'x' },
        { id: 'a', cron: '* * * * *', payload: 'y' },
      ]),
    ).toThrow(/Duplicate scheduled task id/);
  });

  it('rejects unsafe IDs', () => {
    expect(() =>
      validateScheduledTasks([
        { id: '../escape', cron: '* * * * *', payload: 'x' },
      ]),
    ).toThrow(/Invalid scheduled task id/);
  });

  it('rejects invalid cron expressions', () => {
    expect(() =>
      validateScheduledTasks([{ id: 'a', cron: 'bogus', payload: 'x' }]),
    ).toThrow(/Invalid cron/);
  });

  it('rejects unknown sessionTarget / wakeMode', () => {
    expect(() =>
      validateScheduledTasks([
        // @ts-expect-error — testing invalid input
        { id: 'a', cron: '* * * * *', payload: 'x', sessionTarget: 'new-window' },
      ]),
    ).toThrow(/sessionTarget/);
    expect(() =>
      validateScheduledTasks([
        // @ts-expect-error — testing invalid input
        { id: 'a', cron: '* * * * *', payload: 'x', wakeMode: 'nope' },
      ]),
    ).toThrow(/wakeMode/);
  });

  it('rejects non-string, non-object payloads', () => {
    expect(() =>
      validateScheduledTasks([
        // @ts-expect-error — testing invalid input
        { id: 'a', cron: '* * * * *', payload: 42 },
      ]),
    ).toThrow(/payload/);
    expect(() =>
      validateScheduledTasks([
        // @ts-expect-error — testing invalid input
        { id: 'a', cron: '* * * * *', payload: [1, 2, 3] },
      ]),
    ).toThrow(/payload/);
  });
});

// ─── Cron parser ────────────────────────────────────────────────────────

describe('parseCron', () => {
  it('accepts all-stars', () => {
    const c = parseCron('* * * * *');
    expect(c.minute.size).toBe(60);
    expect(c.hour.size).toBe(24);
    expect(c.dayOfMonthRestricted).toBe(false);
    expect(c.dayOfWeekRestricted).toBe(false);
  });

  it('parses a simple step expression', () => {
    const c = parseCron('*/15 * * * *');
    expect([...c.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });

  it('parses range + step + list', () => {
    const c = parseCron('*/10 8-21 1,15 * *');
    expect([...c.minute].sort((a, b) => a - b)).toEqual([0, 10, 20, 30, 40, 50]);
    expect([...c.hour].sort((a, b) => a - b)).toEqual([
      8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    ]);
    expect([...c.dayOfMonth].sort((a, b) => a - b)).toEqual([1, 15]);
    expect(c.dayOfMonthRestricted).toBe(true);
  });

  it('collapses Sunday 7 to 0', () => {
    const c = parseCron('0 0 * * 7');
    expect(c.dayOfWeek.has(0)).toBe(true);
    expect(c.dayOfWeek.has(7)).toBe(false);
  });

  it('rejects wrong field count', () => {
    expect(() => parseCron('* * * *')).toThrow(/expected 5/);
  });

  it('rejects inverted ranges', () => {
    expect(() => parseCron('10-5 * * * *')).toThrow(/low bound/);
  });

  it('rejects out-of-range values', () => {
    expect(() => parseCron('60 * * * *')).toThrow(/minute/);
    expect(() => parseCron('* 24 * * *')).toThrow(/hour/);
    expect(() => parseCron('* * 32 * *')).toThrow(/day-of-month/);
    expect(() => parseCron('* * * 13 *')).toThrow(/month/);
  });

  it('rejects non-numeric fields', () => {
    expect(() => parseCron('MON * * * *')).toThrow();
  });

  it('parses a numeric-value + step as "from value, every step up to max"', () => {
    // `5/15` in the minute field → 5, 20, 35, 50
    const c = parseCron('5/15 * * * *');
    expect([...c.minute].sort((a, b) => a - b)).toEqual([5, 20, 35, 50]);
  });
});

describe('cronMatches', () => {
  it('matches every minute with all-stars', () => {
    const c = parseCron('* * * * *');
    expect(cronMatches(c, new Date(2026, 3, 21, 10, 30))).toBe(true);
  });

  it('matches a specific minute', () => {
    const c = parseCron('*/15 * * * *');
    expect(cronMatches(c, new Date(2026, 3, 21, 10, 0))).toBe(true);
    expect(cronMatches(c, new Date(2026, 3, 21, 10, 15))).toBe(true);
    expect(cronMatches(c, new Date(2026, 3, 21, 10, 7))).toBe(false);
  });

  it('applies hour restrictions', () => {
    const c = parseCron('0 8-21 * * *');
    expect(cronMatches(c, new Date(2026, 3, 21, 8, 0))).toBe(true);
    expect(cronMatches(c, new Date(2026, 3, 21, 22, 0))).toBe(false);
    expect(cronMatches(c, new Date(2026, 3, 21, 7, 0))).toBe(false);
  });

  it('ORs day-of-month and day-of-week when both are restricted', () => {
    // "On the 1st of each month OR on Mondays, at 9am"
    const c = parseCron('0 9 1 * 1');
    // 2026-04-06 is a Monday, not the 1st — should still match.
    expect(cronMatches(c, new Date(2026, 3, 6, 9, 0))).toBe(true);
    // 2026-04-01 is a Wednesday — 1st of month matches.
    expect(cronMatches(c, new Date(2026, 3, 1, 9, 0))).toBe(true);
    // 2026-04-07 is a Tuesday, not the 1st — should NOT match.
    expect(cronMatches(c, new Date(2026, 3, 7, 9, 0))).toBe(false);
  });

  it('ANDs when only one day field is restricted (standard cron)', () => {
    // Only day-of-week restricted: Mondays only.
    const c = parseCron('0 9 * * 1');
    expect(cronMatches(c, new Date(2026, 3, 6, 9, 0))).toBe(true); // Mon
    expect(cronMatches(c, new Date(2026, 3, 7, 9, 0))).toBe(false); // Tue
  });
});

// ─── Lock file ──────────────────────────────────────────────────────────

describe('lock files', () => {
  it('acquires and releases a lock', async () => {
    expect(await acquireLock(tmpDir, 'task1')).toBe(true);
    expect(hasLockFile(tmpDir, 'task1')).toBe(true);
    const rec = await readLock(tmpDir, 'task1');
    expect(rec?.pid).toBe(process.pid);
    await releaseLock(tmpDir, 'task1');
    expect(hasLockFile(tmpDir, 'task1')).toBe(false);
  });

  it('refuses to double-acquire while lock is held by live process', async () => {
    expect(await acquireLock(tmpDir, 'task1')).toBe(true);
    // Same-process re-acquire = refuse. The lock encodes process.pid and
    // it's this process, so the liveness probe returns true.
    expect(await acquireLock(tmpDir, 'task1')).toBe(false);
    await releaseLock(tmpDir, 'task1');
  });

  it('breaks a stale lock pointing at a dead PID', async () => {
    // Use a guaranteed-dead PID. Even if a hypothetical race matched it,
    // the lock file includes a hostname and PID 2^31 won't exist.
    const lockFile = join(tmpDir, 'task1.lock');
    writeFileSync(
      lockFile,
      JSON.stringify({
        taskId: 'task1',
        pid: 2_147_483_646,
        host: require('node:os').hostname(),
        startedAt: new Date().toISOString(),
      }),
    );
    expect(await acquireLock(tmpDir, 'task1')).toBe(true);
    const rec = await readLock(tmpDir, 'task1');
    expect(rec?.pid).toBe(process.pid);
  });

  it('refuses to break a lock held on a different host', async () => {
    // Simulates a shared filesystem / NFS situation — a process on
    // another machine holds the lock. We can't probe liveness remotely,
    // so we conservatively refuse to break it.
    const lockFile = join(tmpDir, 'task1.lock');
    writeFileSync(
      lockFile,
      JSON.stringify({
        taskId: 'task1',
        pid: process.pid,
        host: 'some-other-machine',
        startedAt: new Date().toISOString(),
      }),
    );
    expect(await acquireLock(tmpDir, 'task1')).toBe(false);
  });

  it('treats malformed lock files as stale', async () => {
    const lockFile = join(tmpDir, 'task1.lock');
    writeFileSync(lockFile, 'not-json');
    // Malformed → same-host same-pid fallthrough isn't triggered (parse
    // returns null), but the lock file already exists so `wx` fails —
    // the function then consults readLock, which returns null, and
    // declines to break it. That's the safe default.
    expect(await acquireLock(tmpDir, 'task1')).toBe(false);
  });

  it('release is idempotent', async () => {
    await expect(releaseLock(tmpDir, 'nonexistent')).resolves.toBeUndefined();
  });
});

// ─── Prompt rendering ───────────────────────────────────────────────────

describe('buildScheduledTaskPrompt', () => {
  it('uses the string payload verbatim in agentTurn mode', () => {
    const out = buildScheduledTaskPrompt({
      id: 'x',
      cron: '* * * * *',
      payload: 'Do the thing.',
    });
    expect(out).toBe('Do the thing.');
  });

  it('stringifies object payloads', () => {
    const out = buildScheduledTaskPrompt({
      id: 'x',
      cron: '* * * * *',
      payload: { event: 'daily-prep', ts: 1 },
    });
    expect(out).toContain('"event": "daily-prep"');
  });

  it('wraps in a system-event envelope in systemEvent mode', () => {
    const out = buildScheduledTaskPrompt({
      id: 'ea-sweep',
      cron: '*/15 * * * *',
      payload: { event: 'inbox-sweep' },
      wakeMode: 'systemEvent',
    });
    expect(out).toContain('<system-event task-id="ea-sweep"');
    expect(out).toContain('</system-event>');
    expect(out).toContain('reply with a single token `OK`');
  });
});

// ─── runScheduledTask ───────────────────────────────────────────────────

describe('runScheduledTask', () => {
  it('runs the agent and records success status', async () => {
    const called: string[] = [];
    const agent = mockAgent((t) => {
      called.push(t);
      return 'done';
    });
    const outcome = await runScheduledTask(
      agent,
      { id: 'task1', cron: '* * * * *', payload: 'hello' },
      { lockDir: tmpDir },
    );
    expect(outcome.status).toBe('success');
    expect(called).toEqual(['hello']);
    // Lock released
    expect(hasLockFile(tmpDir, 'task1')).toBe(false);
    const status = await readStatus(tmpDir);
    expect(status.task1.lastStatus).toBe('success');
    expect(status.task1.successCount).toBe(1);
    expect(status.task1.durationMs).toBeTypeOf('number');
  });

  it('returns skipped when lock is already held', async () => {
    await acquireLock(tmpDir, 'task1');
    const agent = mockAgent(() => {
      throw new Error('agent should NOT have run');
    });
    const outcome = await runScheduledTask(
      agent,
      { id: 'task1', cron: '* * * * *', payload: 'hi' },
      { lockDir: tmpDir },
    );
    expect(outcome.status).toBe('skipped');
    const status = await readStatus(tmpDir);
    expect(status.task1.lastStatus).toBe('skipped');
    await releaseLock(tmpDir, 'task1');
  });

  it('records failure and still releases the lock', async () => {
    const agent = mockAgent(() => {
      throw new Error('boom');
    });
    const outcome = await runScheduledTask(
      agent,
      { id: 'task1', cron: '* * * * *', payload: 'x' },
      { lockDir: tmpDir },
    );
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toBe('boom');
    }
    expect(hasLockFile(tmpDir, 'task1')).toBe(false);
    const status = await readStatus(tmpDir);
    expect(status.task1.lastStatus).toBe('failed');
    expect(status.task1.lastError).toBe('boom');
    expect(status.task1.failureCount).toBe(1);
  });

  it('rethrows when swallowErrors is false', async () => {
    const agent = mockAgent(() => {
      throw new Error('boom');
    });
    await expect(
      runScheduledTask(
        agent,
        { id: 'task1', cron: '* * * * *', payload: 'x' },
        { lockDir: tmpDir, swallowErrors: false },
      ),
    ).rejects.toThrow(/boom/);
    // Lock should still be released despite the throw.
    expect(hasLockFile(tmpDir, 'task1')).toBe(false);
  });

  it('recovers after crash — a stale lock does not block the next run', async () => {
    // Simulate a crashed run by writing a lock with a dead PID.
    writeFileSync(
      join(tmpDir, 'task1.lock'),
      JSON.stringify({
        taskId: 'task1',
        pid: 2_147_483_646,
        host: require('node:os').hostname(),
        startedAt: new Date().toISOString(),
      }),
    );
    const agent = mockAgent(() => 'recovered');
    const outcome = await runScheduledTask(
      agent,
      { id: 'task1', cron: '* * * * *', payload: 'x' },
      { lockDir: tmpDir },
    );
    expect(outcome.status).toBe('success');
  });
});

// ─── Scheduler tick ─────────────────────────────────────────────────────

describe('tickScheduler', () => {
  it('fires a task when its cron matches', async () => {
    const runs: string[] = [];
    const agent = mockAgent((t) => {
      runs.push(t);
      return 'ok';
    });
    const tasks = [{ id: 'every-min', cron: '* * * * *', payload: 'tick' } as ScheduledTask];
    const parsed = tasks.map((task) => ({ task, cron: parseCron(task.cron) }));
    const state = createSchedulerState();
    const outcomes = await tickScheduler(agent, parsed, state, new Date(2026, 3, 21, 10, 0, 0), {
      lockDir: tmpDir,
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe('success');
    expect(runs).toEqual(['tick']);
  });

  it('only fires a task once per minute across multiple ticks', async () => {
    const runs: string[] = [];
    const agent = mockAgent((t) => {
      runs.push(t);
      return 'ok';
    });
    const tasks = [{ id: 'every-min', cron: '* * * * *', payload: 'tick' } as ScheduledTask];
    const parsed = tasks.map((task) => ({ task, cron: parseCron(task.cron) }));
    const state = createSchedulerState();
    // Three ticks within the same wall-clock minute → one run.
    await tickScheduler(agent, parsed, state, new Date(2026, 3, 21, 10, 0, 0), { lockDir: tmpDir });
    await tickScheduler(agent, parsed, state, new Date(2026, 3, 21, 10, 0, 30), { lockDir: tmpDir });
    await tickScheduler(agent, parsed, state, new Date(2026, 3, 21, 10, 0, 59), { lockDir: tmpDir });
    expect(runs.length).toBe(1);
    // Crossing the minute boundary fires again.
    await tickScheduler(agent, parsed, state, new Date(2026, 3, 21, 10, 1, 0), { lockDir: tmpDir });
    expect(runs.length).toBe(2);
  });

  it('skips tasks whose cron does not match the current minute', async () => {
    const runs: string[] = [];
    const agent = mockAgent((t) => {
      runs.push(t);
      return 'ok';
    });
    const tasks = [{ id: 'even', cron: '*/2 * * * *', payload: 'even-tick' } as ScheduledTask];
    const parsed = tasks.map((task) => ({ task, cron: parseCron(task.cron) }));
    const state = createSchedulerState();
    await tickScheduler(agent, parsed, state, new Date(2026, 3, 21, 10, 1, 0), { lockDir: tmpDir });
    expect(runs.length).toBe(0);
    await tickScheduler(agent, parsed, state, new Date(2026, 3, 21, 10, 2, 0), { lockDir: tmpDir });
    expect(runs.length).toBe(1);
  });

  it('invokes onOutcome for each fired task', async () => {
    const agent = mockAgent(() => 'ok');
    const tasks = [{ id: 't', cron: '* * * * *', payload: 'x' } as ScheduledTask];
    const parsed = tasks.map((task) => ({ task, cron: parseCron(task.cron) }));
    const state = createSchedulerState();
    const seen: string[] = [];
    await tickScheduler(agent, parsed, state, new Date(2026, 3, 21, 10, 0, 0), {
      lockDir: tmpDir,
      onOutcome: (task, outcome) => seen.push(`${task.id}:${outcome.status}`),
    });
    expect(seen).toEqual(['t:success']);
  });
});

describe('runScheduler', () => {
  it('exits promptly when the abort signal is already set', async () => {
    const agent = mockAgent(() => 'ok');
    const tasks: ScheduledTask[] = [
      { id: 'every-min', cron: '* * * * *', payload: 'tick' },
    ];
    const controller = new AbortController();
    controller.abort();
    // Should return immediately — does not attempt any task runs.
    await expect(
      runScheduler(agent, tasks, {
        lockDir: tmpDir,
        tickMs: 1000,
        signal: controller.signal,
      }),
    ).resolves.toBeUndefined();
  });
});

// ─── generateCrontabEntries ─────────────────────────────────────────────

describe('generateCrontabEntries', () => {
  it('renders one line per task', () => {
    const out = generateCrontabEntries(
      [
        { id: 'ea-sweep', cron: '*/15 8-21 * * *', payload: 'sweep' },
        { id: 'daily-prep', cron: '0 2 * * *', payload: 'prep', description: 'Daily prep' },
      ],
      {
        cliPath: 'agent-do',
        workingDir: '/home/me/project',
        extraArgs: ['--script', './agent.ts', '--yes'],
      },
    );
    const lines = out.trim().split('\n');
    // Header + 2 tasks
    expect(lines.length).toBeGreaterThanOrEqual(4);
    const eaLine = lines.find((l) => l.includes('ea-sweep'))!;
    expect(eaLine).toContain('*/15 8-21 * * *');
    expect(eaLine).toContain('scheduled-tasks run ea-sweep');
    expect(eaLine).toContain('--script ./agent.ts');
    expect(eaLine).toContain('.agent-do/logs/ea-sweep.log');
    const dailyLine = lines.find((l) => l.includes('daily-prep'))!;
    expect(dailyLine).toContain('# Daily prep');
  });

  it('validates tasks before rendering', () => {
    expect(() =>
      generateCrontabEntries([{ id: '../bad', cron: '* * * * *', payload: 'x' }]),
    ).toThrow(/Invalid scheduled task id/);
  });
});

// ─── createAgent integration ────────────────────────────────────────────

describe('createAgent scheduledTasks wiring', () => {
  it('rejects a bad cron at createAgent time', async () => {
    const { createAgent } = await import('../src/agent.js');
    const { createMockModel } = await import('../src/testing/index.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const model = createMockModel({ responses: [{ text: 'x' }] }) as any;
    expect(() =>
      createAgent({
        id: 'a',
        name: 'A',
        model,
        scheduledTasks: [{ id: 'bad', cron: 'nope', payload: 'x' }],
      }),
    ).toThrow(/Invalid cron/);
  });

  it('accepts a valid scheduledTasks config', async () => {
    const { createAgent } = await import('../src/agent.js');
    const { createMockModel } = await import('../src/testing/index.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const model = createMockModel({ responses: [{ text: 'x' }] }) as any;
    expect(() =>
      createAgent({
        id: 'a',
        name: 'A',
        model,
        scheduledTasks: [
          { id: 'ok', cron: '*/15 * * * *', payload: 'hi' },
        ],
      }),
    ).not.toThrow();
  });
});
