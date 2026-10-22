import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../src/cli/args.js';
// Imported statically on purpose: the `run` cases used to `await import()` this
// module inside the first test case, so that case paid the cold transform +
// module init for the whole CLI graph. Under fleet CPU contention that alone
// exceeded vitest's default 5s test timeout and turned unrelated lanes' gates
// red (agent-do-512). Module evaluation has no side effects that depend on the
// per-test env stub below, so hoisting is behaviour-preserving.
import { loadTasks, runScheduledTasksMode } from '../src/cli/scheduled-tasks-cmd.js';

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

describe('runScheduledTasksMode — run', { timeout: 15_000 }, () => {
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
    const args = parseArgs(['scheduled-tasks', 'run', 'x', '--tasks', tasksFile]);
    await expect(runScheduledTasksMode(args)).rejects.toThrow(/No scheduled-tasks file/);
  });

  it('throws clearly when the task id is unknown', async () => {
    await writeFile(tasksFile, JSON.stringify([
      { id: 'known', cron: '* * * * *', payload: 'hi' },
    ]));
    const args = parseArgs(['scheduled-tasks', 'run', 'missing', '--tasks', tasksFile, '--memory', dir]);
    await expect(runScheduledTasksMode(args)).rejects.toThrow(/No scheduled task "missing"/);
  });

  it('throws on a tasks file with a bad cron (validation surfaces)', async () => {
    await writeFile(tasksFile, JSON.stringify([
      { id: 'bad', cron: '* * *', payload: 'hi' }, // 3 fields
    ]));
    const args = parseArgs(['scheduled-tasks', 'list', '--tasks', tasksFile]);
    await expect(runScheduledTasksMode(args)).rejects.toThrow(/expected 5 fields/);
  });

  it('list prints the configured tasks', async () => {
    await writeFile(tasksFile, JSON.stringify([
      { id: 'sweep', cron: '*/15 * * * *', payload: 'triage', description: 'inbox' },
      { id: 'daily', cron: '0 2 * * *', payload: 'prep' },
    ]));
    const args = parseArgs(['scheduled-tasks', 'list', '--tasks', tasksFile]);
    const out = captureStdout(() => runScheduledTasksMode(args));
    const text = await out;
    expect(text).toContain('sweep');
    expect(text).toContain('*/15 * * * *');
    expect(text).toContain('inbox');
    expect(text).toContain('daily');
  });

  it('a description containing a newline cannot forge a list row (agent-do-bc4)', async () => {
    // The listing is a table: rows are our structure, values are not. Escaping the assembled row instead left this
    // open, because the row sanitiser preserves newlines - so a task description could print an extra line that
    // looks like another task.
    await writeFile(tasksFile, JSON.stringify([
      { id: 'sweep', cron: '*/15 * * * *', payload: 'triage', description: 'ok\nforged-task\t*/1 * * * *' },
    ]));
    const args = parseArgs(['scheduled-tasks', 'list', '--tasks', tasksFile]);
    const text = await captureStdout(() => runScheduledTasksMode(args));
    expect(text).toContain('sweep');
    expect(text, 'a newline in a description started a new row').not.toMatch(/^forged-task/m);
    expect(text, 'a tab in a description forged a column').not.toContain('?row\t');
    expect(text).not.toContain('\t*/1 * * * *');
    expect(text, 'the attempt should be visible').toContain('?');
  });

  it('install emits one crontab line per task invoking `scheduled-tasks run`', async () => {
    await writeFile(tasksFile, JSON.stringify([
      { id: 'sweep', cron: '*/15 * * * *', payload: 'triage' },
    ]));
    const args = parseArgs(['scheduled-tasks', 'install', '--tasks', tasksFile, '--memory', dir]);
    const text = await captureStdout(() => runScheduledTasksMode(args));
    expect(text).toMatch(/\/15 \* \* \* \* .* scheduled-tasks run sweep/);
    expect(text).toContain('--tasks');
    expect(text).toContain('--memory');
  });

  // Rows are our structure; the description is data. Install used to interpolate it raw, so a newline
  // in a description emitted a SECOND, standalone crontab row that system cron would execute on
  // schedule (agent-do-hvh) — the install counterpart of the list-row fix (agent-do-bc4).
  it("a description containing a newline cannot forge a crontab entry (agent-do-hvh)", async () => {
    await writeFile(tasksFile, JSON.stringify([
      { id: 'safe', cron: '0 0 * * *', payload: 'hi', description: 'ordinary\n* * * * * /bin/echo ROGUE_JOB' },
    ]));
    const args = parseArgs(['scheduled-tasks', 'install', '--tasks', tasksFile, '--memory', dir]);
    const text = await captureStdout(() => runScheduledTasksMode(args));
    const rows = text.split('\n').filter((l) => l.length > 0 && !l.startsWith('#'));
    expect(rows, 'the description must not add a second executable row').toHaveLength(1);
    expect(rows[0]).toContain('scheduled-tasks run safe');
    // The attempt stays visible but inert: the newline became `?`, so the forged
    // cron fields are text inside the one row's trailing comment.
    expect(rows[0]).toContain('ordinary?* * * * * /bin/echo ROGUE_JOB');
  });

  it('a bare % in a description cannot start cron stdin injection (agent-do-hvh)', async () => {
    await writeFile(tasksFile, JSON.stringify([
      { id: 'safe', cron: '0 0 * * *', payload: 'hi', description: 'report%50%done' },
    ]));
    const args = parseArgs(['scheduled-tasks', 'install', '--tasks', tasksFile, '--memory', dir]);
    const text = await captureStdout(() => runScheduledTasksMode(args));
    const row = text.split('\n').find((l) => l.includes('scheduled-tasks run safe'))!;
    expect(row).toContain('report\\%50\\%done');
    // Every % in the row is cron-escaped; an unescaped one would end the command
    // and feed the rest of the line to the job's stdin.
    expect(row).not.toMatch(/(^|[^\\])%/);
  });

  it('install single-quotes paths so shell metacharacters cannot break out (agent-do-hvh)', async () => {
    // cron runs the row with `/bin/sh -c`; inside unescaped double quotes a `$(`,
    // backtick or `"` in the path executed in the fired job.
    const evil = join(dir, 'ta"sks;$(reboot).json');
    await writeFile(evil, JSON.stringify([{ id: 'sweep', cron: '*/15 * * * *', payload: 'triage' }]));
    const args = parseArgs(['scheduled-tasks', 'install', '--tasks', evil, '--memory', dir]);
    const text = await captureStdout(() => runScheduledTasksMode(args));
    const row = text.split('\n').find((l) => l.includes('scheduled-tasks run sweep'))!;
    expect(row).toContain(`--tasks '${evil}'`);
    expect(row).toContain(`--memory '${dir}'`);
  });

  it('a single quote or % inside a path is escaped, not broken out of (agent-do-hvh)', async () => {
    const evil = join(dir, "it's 50%.json");
    await writeFile(evil, JSON.stringify([{ id: 'sweep', cron: '*/15 * * * *', payload: 'triage' }]));
    const args = parseArgs(['scheduled-tasks', 'install', '--tasks', evil, '--memory', dir]);
    const text = await captureStdout(() => runScheduledTasksMode(args));
    const row = text.split('\n').find((l) => l.includes('scheduled-tasks run sweep'))!;
    // The exact documented encoding: `'` → `'\''` (sh splice), `%` → `\%` (cron escape).
    expect(row).toContain(
      `--tasks '${evil.replace(/'/g, `'\\''`).replace(/%/g, '\\%')}'`,
    );
  });

  it('a newline in a tasks path cannot forge a header line either (agent-do-hvh)', async () => {
    // POSIX paths may contain newlines; the `# tasks file:` header used to interpolate the path raw.
    const evil = join(dir, 'a\nb.json');
    await writeFile(evil, JSON.stringify([{ id: 'sweep', cron: '*/15 * * * *', payload: 'triage' }]));
    const args = parseArgs(['scheduled-tasks', 'install', '--tasks', evil, '--memory', dir]);
    const text = await captureStdout(() => runScheduledTasksMode(args));
    const rows = text.split('\n').filter((l) => l.length > 0 && !l.startsWith('#'));
    expect(rows, 'the header path must not add an executable row').toHaveLength(1);
    expect(rows[0]).toContain('scheduled-tasks run sweep');
    expect(text).toContain('a?b.json');
  });

  // parseCron tokenises with expr.trim().split(/\s+/): a trailing newline is trimmed away and a newline
  // between fields splits into the same five tokens, so the cron STRING can carry a raw \n/\r through
  // validation and split the emitted row into an uninstallable crontab — real `crontab -n` rejects the
  // whole file ("bad month"), so every task stops being scheduled (agent-do-bw1).
  it("a trailing newline in the cron spec cannot split the emitted row (agent-do-bw1)", async () => {
    await writeFile(tasksFile, JSON.stringify([
      { id: 'evil', cron: '0 0 * * *\n', payload: 'hi' },
    ]));
    const args = parseArgs(['scheduled-tasks', 'install', '--tasks', tasksFile, '--memory', dir]);
    const text = await captureStdout(() => runScheduledTasksMode(args));
    const rows = text.split('\n').filter((l) => l.length > 0 && !l.startsWith('#'));
    expect(rows, 'the trailing newline must not split the row in two').toHaveLength(1);
    expect(rows[0]).toMatch(/^0 0 \* \* \* /);
    expect(rows[0]).toContain('scheduled-tasks run evil');
  });

  it('newlines and CRs between cron fields are normalised to single spaces (agent-do-bw1)', async () => {
    await writeFile(tasksFile, JSON.stringify([
      { id: 'evil-nl', cron: '0 0 *\n* *', payload: 'hi' },
      { id: 'evil-cr', cron: '0 0 *\r* *', payload: 'hi' },
    ]));
    const args = parseArgs(['scheduled-tasks', 'install', '--tasks', tasksFile, '--memory', dir]);
    const text = await captureStdout(() => runScheduledTasksMode(args));
    const rows = text.split('\n').filter((l) => l.length > 0 && !l.startsWith('#'));
    expect(rows, 'each task is still exactly one row').toHaveLength(2);
    for (const row of rows) {
      // The spec is the normalised five fields; no raw newline or CR survives into the row.
      expect(row).toMatch(/^0 0 \* \* \* /);
      expect(row.includes('\r'), 'a raw CR must not survive into the row').toBe(false);
      expect(row).toContain('scheduled-tasks run evil-');
    }
  });

  it('status shows the last-run table and reads from the status file', async () => {
    await writeFile(tasksFile, JSON.stringify([
      { id: 'sweep', cron: '*/15 * * * *', payload: 'triage' },
    ]));
    // Pre-seed a status record so the table has a row.
    await writeFile(join(dir, 'scheduler-status.json'), JSON.stringify({
      sweep: { runCount: 7, lastRunAt: '2026-06-19T09:30:00.000Z', lastOutcome: 'ok' },
    }));
    const args = parseArgs(['scheduled-tasks', 'status', '--tasks', tasksFile, '--memory', dir]);
    const text = await captureStdout(() => runScheduledTasksMode(args));
    expect(text).toContain('sweep');
    expect(text).toContain('7');           // runCount
    expect(text).toContain('ok');
    expect(text).toContain('2026-06-19');  // last-run date
  });

  it('status survives a hostile scheduler-status.json end to end (agent-do-24k)', async () => {
    // The pre-0nf failure was a crash in the CLI layer: readStatus handed the
    // raw parsed object to printStatus, whose new Date(lastRunAt).toISOString()
    // threw RangeError on a hand-edited value. This test exercises the actual
    // command path, not just readStatus.
    await writeFile(tasksFile, JSON.stringify([
      { id: 'sweep', cron: '*/15 * * * *', payload: 'triage' },
    ]));
    await writeFile(join(dir, 'scheduler-status.json'),
      '{"sweep":{"runCount":"garbage","lastRunAt":"not-a-date"},"also-bad":true'); // malformed JSON too
    const args = parseArgs(['scheduled-tasks', 'status', '--tasks', tasksFile, '--memory', dir]);
    const text = await captureStdout(() => runScheduledTasksMode(args));
    expect(text).toContain('sweep');
    expect(text).toContain('never');  // no valid last-run to show
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

describe('task payloads are data, not structure (agent-do-upf)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sched-payload-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps payload keys that look like pollution keys', async () => {
    // Raw JSON text, not an object literal: a literal's `__proto__:` sets the
    // prototype and creates NO own property, so JSON.stringify would emit no such
    // key and the test would prove nothing (agent-do-kux).
    //
    // A dropping reviver at the loader erased `constructor` and `prototype`, so the
    // agent received only {"body":"hello"} (agent-do-upf).
    const file = join(dir, 'tasks.json');
    await writeFile(
      file,
      '[{"id":"daily","cron":"* * * * *","payload":{"constructor":"report","prototype":"v1","body":"hello"}}]',
    );
    const tasks = await loadTasks(file);
    const payload = tasks[0].payload as Record<string, unknown>;
    expect(payload.constructor).toBe('report');
    expect(payload.prototype).toBe('v1');
    expect(payload.body).toBe('hello');
  });

  it('drops an own __proto__ payload key without applying or inheriting it', async () => {
    // Measured limit (agent-do-kux): JSON.parse makes `__proto__` an own property,
    // then Zod's record rebuild drops it. Safe - no prototype is retargeted and
    // nothing is inherited - but not preserved, and the comment above says so.
    const file = join(dir, 'tasks-proto-payload.json');
    await writeFile(
      file,
      '[{"id":"daily","cron":"* * * * *","payload":{"__proto__":{"body":"evil","inherited":true},"body":"hello"}}]',
    );
    const tasks = await loadTasks(file);
    const payload = tasks[0].payload as Record<string, unknown>;
    expect(Object.hasOwn(payload, '__proto__')).toBe(false);
    expect(Object.getPrototypeOf(payload)).toBe(Object.prototype);
    expect(payload.inherited).toBeUndefined();
    expect(payload.body).toBe('hello');
    expect(({} as Record<string, unknown>).inherited).toBeUndefined();
  });

  it('still discards structural keys at the task level', async () => {
    const file = join(dir, 'tasks-structural.json');
    await writeFile(
      file,
      '[{"id":"daily","cron":"* * * * *","payload":"text","__proto__":{"polluted":true}}]',
    );
    const tasks = await loadTasks(file);
    expect(tasks[0].id).toBe('daily');
    expect(tasks[0]).not.toHaveProperty('__proto__');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
