/**
 * CLI subcommand: `agent-do scheduled-tasks` (#79).
 *
 * Manages cron-driven agent runs. Tasks live in a JSON file
 * (`<memoryDir>/scheduled-tasks.json` by default) so `install` can emit
 * crontab entries from the same source the operator edits.
 *
 *   agent-do scheduled-tasks list [--tasks <file>]
 *   agent-do scheduled-tasks run <id> [--tasks <file>] [--memory <dir>] [model opts]
 *   agent-do scheduled-tasks status [--tasks <file>] [--memory <dir>]
 *   agent-do scheduled-tasks install [--tasks <file>]
 *   agent-do scheduled-tasks start [--tasks <file>] [--memory <dir>]
 *
 * Each `run` acquires the #15 file lock and records last-run status, so
 * overlapping cron firings skip and a crashed run is reclaimed. `install`
 * emits one crontab line per task that calls back into
 * `agent-do scheduled-tasks run <id>` — the system cron does the timing;
 * agent-do does the safe execution.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { ParsedArgs } from './args.js';
import { resolveModel } from './resolve-model.js';
import { createAgent } from '../agent.js';
import { emitSandboxWarning } from './warnings.js';
import { matchesCron, validateScheduledTasks } from '../scheduled-tasks.js';
import { readStatus, runScheduledTask } from '../scheduled-tasks/fs.js';
import type { ScheduledTask } from '../scheduled-tasks.js';
import { sanitiseForLine, sanitiseRow } from './terminal-safety.js';
import { writeAnswerChunk } from './answer-stream.js';

/** Tasks file: a JSON array of ScheduledTask, optionally with `description`. */
const TasksFileSchema = z.array(
  z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    cron: z.string(),
    payload: z.union([z.string(), z.record(z.string(), z.unknown())]),
    description: z.string().optional(),
    sessionTarget: z.enum(['isolated', 'main']).optional(),
    wakeMode: z.enum(['agentTurn', 'systemEvent']).optional(),
  }),
);

export async function runScheduledTasksMode(args: ParsedArgs): Promise<void> {
  const sub = args.scheduledTasksSubcommand;
  const tasksFile = args.tasksFile!;

  switch (sub) {
    case 'list':
      return printList(tasksFile);
    case 'status':
      return printStatus(tasksFile, args.memoryDir);
    case 'install':
      return printInstall(tasksFile, args);
    case 'start':
      return runForegroundLoop(tasksFile, args);
    case 'run':
      if (!args.scheduledTaskId) {
        throw new Error('Usage: agent-do scheduled-tasks run <id>');
      }
      return runOne(tasksFile, args.memoryDir, args.scheduledTaskId, args);
    default:
      throw new Error(`Unknown scheduled-tasks subcommand: ${sub}`);
  }
}

/**
 * Exported so the payload-preservation guarantee below can be tested without
 * running a task (agent-do-upf).
 */
export async function loadTasks(tasksFile: string): Promise<ScheduledTask[]> {
  let raw: string;
  try {
    raw = await readFile(tasksFile, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `No scheduled-tasks file at ${tasksFile}. Create one (a JSON array of {id,cron,payload}) or pass --tasks <path>.`,
      );
    }
    throw err;
  }
  // Deliberately a bare JSON.parse, NOT a prototype-pollution reviver: `payload`
  // is opaque user data (`z.record(z.string(), z.unknown())`), so a legitimate key
  // named `constructor` or `prototype` inside it is DATA and must survive. A
  // dropping reviver here silently erased those fields before the payload was
  // stringified for the agent (agent-do-upf).
  //
  // One honest limit, measured rather than assumed (agent-do-kux): an OWN
  // `__proto__` key inside a payload does not survive. JSON.parse creates it as an
  // own property, and Zod's record rebuild then drops it — it is not applied to any
  // prototype (the rebuilt object still has Object.prototype, and nothing is
  // inherited from the hostile value), so it is safe, but it is not preserved
  // either. Preserving it would mean bypassing that rebuild, which is not worth it
  // for a field name that exists only to be a prototype key.
  //
  // Structure is still safe: the array and task objects are rebuilt by Zod from the
  // declared fields only, so a `__proto__` at the structural level is discarded
  // rather than merged, and nothing here assigns parsed keys onto another object.
  const parsed = TasksFileSchema.parse(JSON.parse(raw));
  return validateScheduledTasks(parsed);
}

async function printList(tasksFile: string): Promise<void> {
  const tasks = await loadTasks(tasksFile);
  if (tasks.length === 0) {
    console.log('(no scheduled tasks)');
    return;
  }
  for (const t of tasks) {
    // Note the separation: the tab-separated rows are OUR structure, so the separator and the ` — description`
    // suffix are emitted as-is, and only the values are single-lined. Escaping the assembled row instead (the
    // previous code) left a description able to forge a row, because the row sanitiser preserves newlines
    // (agent-do-bc4 follow-up).
    console.log(sanitiseRow([t.id, t.cron], '\t', t.description ? ` — ${t.description}` : ''));
  }
}

async function printStatus(tasksFile: string, memoryDir: string): Promise<void> {
  const tasks = await loadTasks(tasksFile);
  const statusFile = resolveStatusFile(memoryDir);
  const status = await readStatus(statusFile);
  if (tasks.length === 0) {
    console.log('(no scheduled tasks)');
    return;
  }
  console.log('id\tschedule\tlast-run\toutcome\truns');
  for (const t of tasks) {
    const s = status[t.id];
    const last = s?.lastRunAt ? new Date(s.lastRunAt).toISOString().replace('T', ' ').slice(0, 19) : 'never';
    const outcome = s?.lastOutcome ?? '-';
    console.log(sanitiseRow([t.id, t.cron, last, outcome, s?.runCount ?? 0]));
  }
  console.log(`\n(status at ${sanitiseForLine(statusFile)})`);
}

/**
 * Make a value structurally inert for a crontab.
 *
 * Whatever this receives — a task description from the tasks JSON, a filesystem
 * path — it must not be able to change the SHAPE of the emitted crontab
 * (agent-do-hvh):
 *
 * - A crontab's structure is NEWLINE-delimited, and cron's line parser does not
 *   see shell quoting, so a raw newline inside even a quoted path started a
 *   second, standalone crontab entry that system cron executed on schedule.
 *   `sanitiseForLine` collapses newlines (and other control characters) to a
 *   visible `?` — the attempt stays visible, but cannot add rows.
 * - An unescaped `%` is cron's command/stdin separator: everything after the
 *   first one is fed to the command's stdin, and the command is truncated
 *   before it (which would also leave a shell quote unclosed). `%` gets cron's
 *   documented `\%` escape.
 */
function cronSafe(value: string): string {
  return sanitiseForLine(value).replace(/%/g, '\\%');
}

/**
 * Quote a value so the shell cron uses to run commands (`/bin/sh -c`) treats it
 * as ONE literal argument. POSIX single quotes with the `'\''` splice: nothing
 * between single quotes is interpreted, and the only character that can end
 * them is `'` itself, which is closed, escaped and reopened mid-string. The
 * previous double quotes were inert-looking but real: a `$(`, backtick or `"`
 * inside a tasks-file path executed in the fired job. Values pass through
 * {@link cronSafe} first — quoting is for the SHELL, but cron splits entries at
 * newlines long before the shell sees anything (agent-do-hvh).
 */
function shQuote(value: string): string {
  return `'${cronSafe(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Normalise a task's cron spec into one line of single-spaced fields, without
 * changing which minutes it selects.
 *
 * The cron value is FUNCTIONAL text, so {@link cronSafe}'s `?` markers are the
 * wrong tool here — replacing a newline with `?` would leave a spec that still
 * fails to install (agent-do-bw1). The trap is that `parseCron` tokenises with
 * `expr.trim().split(/\s+/)`: a trailing newline is trimmed away and a newline
 * or CR between fields splits into the same five tokens, so an expression whose
 * STRING still carries a raw `\n`/`\r` passes validation yet reached the row
 * verbatim, splitting it into an uninstallable crontab (real `crontab -n`:
 * "bad minute" / "bad month" / "bad day-of-week") — the whole file fails, so
 * every task silently stops being scheduled. Collapsing every whitespace run to
 * one space is semantics-identical to that tokenisation (`matchesCron` splits
 * on `/\s+/` too, so the emitted spec and the foreground loop agree
 * field-for-field) and makes a newline or CR impossible in the emitted spec by
 * construction.
 */
function normaliseCronSpec(spec: string): string {
  return spec.trim().split(/\s+/).join(' ');
}

/**
 * Emit crontab lines that invoke `agent-do scheduled-tasks run <id>` per task.
 * The operator appends the output to their crontab / systemd timer. We use the
 * resolved absolute tasks-file path so the fired job reads the same file
 * regardless of the cron user's cwd.
 *
 * Everything interpolated into a row comes from the tasks JSON or the
 * filesystem, none of it is trusted as structure: ids are constrained upstream
 * (`[a-zA-Z0-9_-]+`), the cron spec is whitespace-normalised here (see
 * {@link normaliseCronSpec} — parseCron's tokenisation tolerates newlines the
 * string may still carry), and paths and descriptions are quoted and
 * single-lined here, so a hostile task can emit no more than its one inert row.
 */
async function printInstall(tasksFile: string, args: ParsedArgs): Promise<void> {
  const tasks = await loadTasks(tasksFile);
  const absTasks = resolve(tasksFile);
  const memory = resolve(args.memoryDir);
  const bin = shQuote(process.argv[1] ?? 'agent-do');
  const lines: string[] = [
    '# agent-do scheduled tasks — append to your crontab (crontab -e) or systemd timer.',
    `# tasks file: ${sanitiseForLine(absTasks)}`,
    `# memory dir: ${sanitiseForLine(memory)}`,
  ];
  for (const t of tasks) {
    const spec = normaliseCronSpec(t.cron);
    const comment = t.description ? ` # ${cronSafe(t.description)}` : '';
    lines.push(
      `${spec} ${bin} scheduled-tasks run ${t.id} --tasks ${shQuote(absTasks)} --memory ${shQuote(memory)}${comment}`,
    );
  }
  console.log(lines.join('\n'));
}

async function runOne(tasksFile: string, memoryDir: string, taskId: string, args: ParsedArgs): Promise<void> {
  const tasks = await loadTasks(tasksFile);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    throw new Error(`No scheduled task "${taskId}" in ${tasksFile}. Available: ${tasks.map((t) => t.id).join(', ') || '(none)'}`);
  }

  // Same warning posture as prompt mode — a scheduled run can touch files.
  emitSandboxWarning({ toolsEnabled: !args.noTools, readOnly: args.readOnly, json: args.json });

  const model = await resolveModel(args.provider, args.model);
  // Build a fresh agent from CLI flags. sessionTarget 'main' (persistent
  // conversation) is accepted in the schema but not yet wired — every run
  // is isolated in v1.
  const agent = createAgent({
    id: `scheduled:${taskId}`,
    name: `scheduled:${taskId}`,
    model,
    systemPrompt: args.systemPrompt,
    maxIterations: args.maxIterations,
    usage: { enabled: true },
  });

  const result = await runScheduledTask(taskId, {
    memoryDir,
    statusFile: resolveStatusFile(memoryDir),
    run: async (payloadText) => {
      const out = await agent.run(payloadText);
      // `out` is the agent's answer - model output shaped by whatever the task read - so it goes through the same
      // seam as the interactive/one-shot answers rather than straight to the terminal (agent-do-wcq sweep).
      if (!args.json) writeAnswerChunk(out + '\n');
      return out;
    },
    payload: task.payload,
  });

  if (result.skipped) {
    process.stderr.write(`[scheduled-tasks] skipped "${taskId}" — another run holds the lock.\n`);
    return;
  }
  if (!result.ok) {
    // `result.error` comes from a whole agent run, so it can embed provider or tool output: the operator's terminal
    // is a consumer of that text and has to be defended the same way the model is (agent-do-9zk). Single-line,
    // because this is ONE log line: a newline inside the message would forge a second one (agent-do-bc4 follow-up).
    process.stderr.write(`[scheduled-tasks] "${sanitiseForLine(taskId)}" failed: ${sanitiseForLine(String(result.error))}\n`);
    process.exit(1);
  }
}

/**
 * Foreground scheduler loop — checks every minute and runs any task whose
 * cron matches the current minute. For dev/testing; production wiring is
 * `install` + system cron. Honours SIGINT/SIGTERM for a clean exit.
 */
async function runForegroundLoop(tasksFile: string, args: ParsedArgs): Promise<void> {
  const memoryDir = args.memoryDir;
  const statusFile = resolveStatusFile(memoryDir);
  process.stderr.write(`[scheduled-tasks] foreground loop. tasks=${tasksFile} memory=${memoryDir}\n`);
  process.stderr.write('[scheduled-tasks] Ctrl+C to stop.\n');

  let stopped = false;
  const stop = () => { stopped = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // Run an immediate tick, then on each minute boundary.
  await tick();
  while (!stopped) {
    await new Promise((r) => setTimeout(r, 1000));
    const now = new Date();
    if (now.getSeconds() === 0) await tick();
  }
  process.stderr.write('[scheduled-tasks] stopped.\n');

  async function tick(): Promise<void> {
    const tasks = await loadTasks(tasksFile).catch(() => [] as ScheduledTask[]);
    const now = new Date();
    for (const t of tasks) {
      if (!matchesCron(t.cron, now)) continue;
      process.stderr.write(`[scheduled-tasks] ${now.toISOString()} firing "${t.id}"\n`);
      // Reuse runOne so the lock + status + agent wiring is identical to the
      // crontab-driven path. Swallow errors — a failing task mustn't kill the loop.
      await runOne(tasksFile, memoryDir, t.id, args).catch((err) => {
        process.stderr.write(
          `[scheduled-tasks] "${sanitiseForLine(t.id)}" errored: ${sanitiseForLine(
            err instanceof Error ? err.message : String(err),
          )}\n`,
        );
      });
    }
  }
}

function resolveStatusFile(memoryDir: string): string {
  return resolve(memoryDir, 'scheduler-status.json');
}

/** Write helper for `scheduled-tasks add`-style tooling (not a CLI verb in v1,
 *  but exported so editors / template packs can persist a tasks file safely). */
export async function writeTasksFile(tasksFile: string, tasks: ScheduledTask[]): Promise<void> {
  await mkdir(dirname(tasksFile), { recursive: true });
  await writeFile(tasksFile, JSON.stringify(tasks, null, 2), 'utf-8');
}
