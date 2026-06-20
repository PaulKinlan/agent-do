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
import {
  matchesCron,
  readStatus,
  runScheduledTask,
  validateScheduledTasks,
  type ScheduledTask,
} from '../scheduled-tasks.js';

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

async function loadTasks(tasksFile: string): Promise<ScheduledTask[]> {
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
    const desc = t.description ? ` — ${t.description}` : '';
    console.log(`${t.id}\t${t.cron}${desc}`);
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
    console.log(`${t.id}\t${t.cron}\t${last}\t${outcome}\t${s?.runCount ?? 0}`);
  }
  console.log(`\n(status at ${statusFile})`);
}

/**
 * Emit crontab lines that invoke `agent-do scheduled-tasks run <id>` per task.
 * The operator appends the output to their crontab / systemd timer. We use the
 * resolved absolute tasks-file path so the fired job reads the same file
 * regardless of the cron user's cwd.
 */
async function printInstall(tasksFile: string, args: ParsedArgs): Promise<void> {
  const tasks = await loadTasks(tasksFile);
  const absTasks = resolve(tasksFile);
  const memory = resolve(args.memoryDir);
  const bin = process.argv[1] ?? 'agent-do';
  const lines: string[] = [
    '# agent-do scheduled tasks — append to your crontab (crontab -e) or systemd timer.',
    `# tasks file: ${absTasks}`,
    `# memory dir: ${memory}`,
  ];
  for (const t of tasks) {
    const comment = t.description ? ` # ${t.description}` : '';
    lines.push(
      `${t.cron} ${bin} scheduled-tasks run ${t.id} --tasks "${absTasks}" --memory "${memory}"${comment}`,
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
      if (!args.json) process.stdout.write(out + '\n');
      return out;
    },
    payload: task.payload,
  });

  if (result.skipped) {
    process.stderr.write(`[scheduled-tasks] skipped "${taskId}" — another run holds the lock.\n`);
    return;
  }
  if (!result.ok) {
    process.stderr.write(`[scheduled-tasks] "${taskId}" failed: ${result.error}\n`);
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
        process.stderr.write(`[scheduled-tasks] "${t.id}" errored: ${err instanceof Error ? err.message : String(err)}\n`);
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
