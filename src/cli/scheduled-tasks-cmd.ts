/**
 * `agent-do scheduled-tasks` — CLI integration for scheduled tasks (#79).
 *
 * Subcommands:
 *
 *   agent-do scheduled-tasks run <id> --script <file>
 *       Run a single scheduled task once. Acquires the task's lock file;
 *       returns non-zero if the lock is already held or the task failed.
 *
 *   agent-do scheduled-tasks start --script <file>
 *       Run the scheduler loop in the foreground. Ticks every minute,
 *       fires any task whose cron matches, prints one-line status per
 *       task. Exits on SIGINT.
 *
 *   agent-do scheduled-tasks status
 *       Show the last-run / last-status / duration for each task, based
 *       on `.agent-do/scheduler/status.json`. Doesn't need a script —
 *       the status file is enough. (Pass --script to filter by tasks
 *       defined in that agent.)
 *
 *   agent-do scheduled-tasks install --script <file>
 *       Print a crontab block to stdout. The user reviews and pastes
 *       into `crontab -e`. We deliberately don't touch the user's
 *       crontab directly.
 *
 * The script file is required for `run`, `start`, and `install` because
 * those actions need the task definitions. Status can read the status
 * file alone.
 */

import * as path from 'node:path';
import type { ParsedArgs } from './args.js';
import { importScriptFile } from './script.js';
import {
  DEFAULT_LOCK_DIR,
  generateCrontabEntries,
  readStatus,
  runScheduledTask,
  runScheduler,
  validateScheduledTasks,
} from '../scheduled-tasks.js';
import type { Agent, AgentConfig, ScheduledTask } from '../types.js';
import { createAgent } from '../agent.js';
import { resolveModel } from './resolve-model.js';

interface LoadedScheduler {
  agent: Agent;
  tasks: ScheduledTask[];
}

/**
 * Load the agent + scheduledTasks list from a `--script <file>` export.
 *
 * Accepts the same export shapes as `agent-do run <file>`:
 * - Agent instance (must be constructed from a config that carries
 *   `scheduledTasks` — we can't recover it from a pre-built instance
 *   that didn't attach the list, so the export must also expose
 *   `scheduledTasks` as a peer export).
 * - AgentConfig (with id, model, and scheduledTasks).
 * - Simple config (with systemPrompt/name and scheduledTasks; model is
 *   resolved via CLI flags).
 */
async function loadScheduler(args: ParsedArgs): Promise<LoadedScheduler> {
  if (!args.file) {
    throw new Error(
      'Scheduled tasks need a script file that exports the agent + tasks.\n' +
        '  npx agent-do scheduled-tasks <action> --script ./my-agent.ts',
    );
  }
  const mod = await importScriptFile(args.file, { yes: args.yes });
  const exported = (mod.default ?? mod) as Record<string, unknown>;

  // Resolve tasks from the export. We accept the tasks either at the
  // top level (`export const scheduledTasks = [...]`) or nested on an
  // AgentConfig / Agent instance (`export default { scheduledTasks }`).
  const tasks = (exported.scheduledTasks as ScheduledTask[] | undefined) ?? [];
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error(
      `${args.file} must export \`scheduledTasks\` (an array of ScheduledTask). ` +
        `Attach them alongside the agent config: \`export const scheduledTasks = [...]\`.`,
    );
  }
  validateScheduledTasks(tasks);

  // Resolve the agent. If the export is already an Agent instance we
  // use it directly; otherwise we build one from the config. Scheduled
  // tasks don't need the full CLI tool wiring because the payload is
  // the whole prompt, so we keep this minimal.
  let agent: Agent;
  if (typeof exported.run === 'function' && typeof exported.stream === 'function') {
    agent = exported as unknown as Agent;
  } else if (exported.model && exported.id) {
    agent = createAgent(exported as unknown as AgentConfig);
  } else if (exported.systemPrompt || exported.name) {
    const model = await resolveModel(
      (exported.provider as string) ?? args.provider,
      (exported.model as string) ?? args.model,
    );
    const agentId = (exported.id as string) ?? 'scheduled-task-agent';
    agent = createAgent({
      id: agentId,
      name: (exported.name as string) ?? agentId,
      model,
      systemPrompt: (exported.systemPrompt as string) ?? args.systemPrompt,
      scheduledTasks: tasks,
    });
  } else {
    throw new Error(
      `${args.file} must export an Agent, AgentConfig, or a simple config with \`scheduledTasks\`.`,
    );
  }
  return { agent, tasks };
}

export async function runScheduledTasksMode(args: ParsedArgs): Promise<void> {
  switch (args.schedulerAction) {
    case 'run':
      return runOne(args);
    case 'start':
      return runLoop(args);
    case 'status':
      return showStatus(args);
    case 'install':
      return showInstall(args);
    default:
      throw new Error(
        'Usage: npx agent-do scheduled-tasks <run|start|status|install> [options]',
      );
  }
}

async function runOne(args: ParsedArgs): Promise<void> {
  const { agent, tasks } = await loadScheduler(args);
  const task = tasks.find((t) => t.id === args.schedulerTaskId);
  if (!task) {
    const known = tasks.map((t) => t.id).join(', ') || '(none)';
    throw new Error(
      `No scheduled task "${args.schedulerTaskId}". Known: ${known}.`,
    );
  }
  const outcome = await runScheduledTask(agent, task, { lockDir: DEFAULT_LOCK_DIR });
  if (outcome.status === 'skipped') {
    process.stderr.write(`[scheduled-tasks] skipped: ${outcome.reason}\n`);
    process.exit(75); // EX_TEMPFAIL — cron will retry on next tick
  }
  if (outcome.status === 'failed') {
    process.stderr.write(`[scheduled-tasks] failed (${outcome.durationMs}ms): ${outcome.error}\n`);
    process.exit(1);
  }
  process.stdout.write(outcome.output);
  if (!outcome.output.endsWith('\n')) process.stdout.write('\n');
  process.stderr.write(`[scheduled-tasks] ok (${outcome.durationMs}ms)\n`);
}

async function runLoop(args: ParsedArgs): Promise<void> {
  const { agent, tasks } = await loadScheduler(args);
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.stderr.write(
    `[scheduled-tasks] starting scheduler with ${tasks.length} task(s). Press Ctrl-C to stop.\n`,
  );
  for (const task of tasks) {
    process.stderr.write(`  - ${task.id}  ${task.cron}\n`);
  }
  try {
    await runScheduler(agent, tasks, {
      signal: controller.signal,
      onOutcome: (task, outcome) => {
        const ts = new Date().toISOString();
        if (outcome.status === 'success') {
          process.stderr.write(`[${ts}] ${task.id}: ok (${outcome.durationMs}ms)\n`);
        } else if (outcome.status === 'failed') {
          process.stderr.write(`[${ts}] ${task.id}: failed — ${outcome.error}\n`);
        } else {
          process.stderr.write(`[${ts}] ${task.id}: skipped — ${outcome.reason}\n`);
        }
      },
    });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

async function showStatus(args: ParsedArgs): Promise<void> {
  const status = await readStatus(DEFAULT_LOCK_DIR);
  let rows = Object.values(status);
  // If a script was supplied, filter down to tasks defined in that file
  // so output matches the active agent's view.
  if (args.file) {
    const { tasks } = await loadScheduler(args);
    const known = new Set(tasks.map((t) => t.id));
    rows = rows.filter((r) => known.has(r.id));
    for (const task of tasks) {
      if (!rows.find((r) => r.id === task.id)) {
        rows.push({ id: task.id });
      }
    }
  }
  if (rows.length === 0) {
    console.log('No scheduled tasks have run yet.');
    return;
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  console.log('Scheduled task status:\n');
  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));
  console.log(
    `  ${pad('ID', 20)} ${pad('LAST RUN', 26)} ${pad('STATUS', 10)} ${pad('DURATION', 10)} SUCCESS/FAIL`,
  );
  for (const row of rows) {
    const last = row.lastRun ?? '—';
    const status = row.lastStatus ?? '—';
    const dur = row.durationMs !== undefined ? `${row.durationMs}ms` : '—';
    const counts = `${row.successCount ?? 0}/${row.failureCount ?? 0}`;
    console.log(
      `  ${pad(row.id, 20)} ${pad(last, 26)} ${pad(status, 10)} ${pad(dur, 10)} ${counts}`,
    );
    if (row.lastError) {
      console.log(`    └── error: ${row.lastError}`);
    }
  }
}

async function showInstall(args: ParsedArgs): Promise<void> {
  const { tasks } = await loadScheduler(args);
  // `--script` requires `-y` for non-TTY; we build an `extraArgs` list
  // so the crontab entry is ready to paste and doesn't need extra flags.
  const extraArgs = [
    '--script',
    path.resolve(args.file!),
    '--yes',
  ];
  const block = generateCrontabEntries(tasks, { extraArgs });
  process.stdout.write(block);
  process.stderr.write(
    '\n[scheduled-tasks] Review the lines above, then run `crontab -e` and paste them in.\n',
  );
}
