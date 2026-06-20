import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../src/cli/args.js';

// ── args parsing for the new subcommand ─────────────────────────────────

describe('parseArgs — scheduled-tasks subcommand', () => {
  it('parses the verb and sets the command', () => {
    const a = parseArgs(['scheduled-tasks', 'list']);
    expect(a.command).toBe('scheduled-tasks');
    expect(a.scheduledTasksSubcommand).toBe('list');
  });

  it('captures the task id for `run`', () => {
    const a = parseArgs(['scheduled-tasks', 'run', 'sweep']);
    expect(a.scheduledTasksSubcommand).toBe('run');
    expect(a.scheduledTaskId).toBe('sweep');
  });

  it('accepts every documented verb', () => {
    for (const v of ['list', 'status', 'install', 'start', 'run'] as const) {
      const a = parseArgs(['scheduled-tasks', v]);
      expect(a.scheduledTasksSubcommand).toBe(v);
    }
  });

  it('rejects an unknown verb', () => {
    expect(() => parseArgs(['scheduled-tasks', 'frobnicate'])).toThrow(/list\|status\|install\|start\|run/);
  });

  it('rejects a missing verb', () => {
    expect(() => parseArgs(['scheduled-tasks'])).toThrow(/Usage/);
  });

  it('defaults tasksFile to <memoryDir>/scheduled-tasks.json', () => {
    const a = parseArgs(['scheduled-tasks', 'list', '--memory', '.data']);
    expect(a.tasksFile).toBe('.data/scheduled-tasks.json');
  });

  it('honours an explicit --tasks path', () => {
    const a = parseArgs(['scheduled-tasks', 'list', '--tasks', '/tmp/my-tasks.json']);
    expect(a.tasksFile).toBe('/tmp/my-tasks.json');
  });

  it('does not treat "scheduled-tasks" appearing as a prompt as a subcommand', () => {
    // When it's NOT the first token, it's a literal prompt (regression guard).
    const a = parseArgs(['Summarize', 'scheduled-tasks']);
    expect(a.command).toBe('prompt');
    expect(a.prompt).toContain('scheduled-tasks');
  });
});

// ── runScheduledTasksMode — the run path ────────────────────────────────

describe('runScheduledTasksMode — run', () => {
  let dir: string;
  let tasksFile: string;
  let savedEnv: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sched-cli-'));
    tasksFile = join(dir, 'tasks.json');
    savedEnv = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-stub';
  });
  afterEach(async () => {
    if (savedEnv === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedEnv;
    await rm(dir, { recursive: true, force: true });
  });

  it('throws clearly when the tasks file is missing', async () => {
    const { runScheduledTasksMode } = await import('../src/cli/scheduled-tasks-cmd.js');
    const args = parseArgs(['scheduled-tasks', 'run', 'x', '--tasks', tasksFile]);
    await expect(runScheduledTasksMode(args)).rejects.toThrow(/No scheduled-tasks file/);
  });

  it('throws clearly when the task id is unknown', async () => {
    await writeFile(tasksFile, JSON.stringify([
      { id: 'known', cron: '* * * * *', payload: 'hi' },
    ]));
    const { runScheduledTasksMode } = await import('../src/cli/scheduled-tasks-cmd.js');
    const args = parseArgs(['scheduled-tasks', 'run', 'missing', '--tasks', tasksFile, '--memory', dir]);
    await expect(runScheduledTasksMode(args)).rejects.toThrow(/No scheduled task "missing"/);
  });

  it('throws on a tasks file with a bad cron (validation surfaces)', async () => {
    await writeFile(tasksFile, JSON.stringify([
      { id: 'bad', cron: '* * *', payload: 'hi' }, // 3 fields
    ]));
    const { runScheduledTasksMode } = await import('../src/cli/scheduled-tasks-cmd.js');
    const args = parseArgs(['scheduled-tasks', 'list', '--tasks', tasksFile]);
    await expect(runScheduledTasksMode(args)).rejects.toThrow(/expected 5 fields/);
  });

  it('list prints the configured tasks', async () => {
    await writeFile(tasksFile, JSON.stringify([
      { id: 'sweep', cron: '*/15 * * * *', payload: 'triage', description: 'inbox' },
      { id: 'daily', cron: '0 2 * * *', payload: 'prep' },
    ]));
    const { runScheduledTasksMode } = await import('../src/cli/scheduled-tasks-cmd.js');
    const args = parseArgs(['scheduled-tasks', 'list', '--tasks', tasksFile]);
    const out = captureStdout(() => runScheduledTasksMode(args));
    const text = await out;
    expect(text).toContain('sweep');
    expect(text).toContain('*/15 * * * *');
    expect(text).toContain('inbox');
    expect(text).toContain('daily');
  });

  it('install emits one crontab line per task invoking `scheduled-tasks run`', async () => {
    await writeFile(tasksFile, JSON.stringify([
      { id: 'sweep', cron: '*/15 * * * *', payload: 'triage' },
    ]));
    const { runScheduledTasksMode } = await import('../src/cli/scheduled-tasks-cmd.js');
    const args = parseArgs(['scheduled-tasks', 'install', '--tasks', tasksFile, '--memory', dir]);
    const text = await captureStdout(() => runScheduledTasksMode(args));
    expect(text).toMatch(/\/15 \* \* \* \* .* scheduled-tasks run sweep/);
    expect(text).toContain('--tasks');
    expect(text).toContain('--memory');
  });

  it('status shows the last-run table and reads from the status file', async () => {
    await writeFile(tasksFile, JSON.stringify([
      { id: 'sweep', cron: '*/15 * * * *', payload: 'triage' },
    ]));
    // Pre-seed a status record so the table has a row.
    await writeFile(join(dir, 'scheduler-status.json'), JSON.stringify({
      sweep: { runCount: 7, lastRunAt: '2026-06-19T09:30:00.000Z', lastOutcome: 'ok' },
    }));
    const { runScheduledTasksMode } = await import('../src/cli/scheduled-tasks-cmd.js');
    const args = parseArgs(['scheduled-tasks', 'status', '--tasks', tasksFile, '--memory', dir]);
    const text = await captureStdout(() => runScheduledTasksMode(args));
    expect(text).toContain('sweep');
    expect(text).toContain('7');           // runCount
    expect(text).toContain('ok');
    expect(text).toContain('2026-06-19');  // last-run date
  });
});

// ── helpers ─────────────────────────────────────────────────────────────

/** Capture stdout.write/console.log output while `fn` runs. */
async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  let captured = '';
  const orig = process.stdout.write.bind(process.stdout);
  const log = console.log;
  process.stdout.write = ((chunk: unknown) => {
    captured += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  }) as typeof process.stdout.write;
  console.log = (...a: unknown[]) => { captured += a.join(' ') + '\n'; };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
    console.log = log;
  }
  return captured;
}

void readFile; // keep import used across describe blocks
