/**
 * Example 16: Scheduled Tasks (#79)
 *
 * Scheduled tasks turn an agent into something closer to a long-running
 * colleague: cron expressions tied to payloads fire the agent at the
 * right time, with lock-file concurrency so two copies never run the
 * same task at once.
 *
 * This example uses a mock model so it runs without any API keys. For
 * production use, replace the model with your real provider and invoke
 * the scheduler from a crontab entry (see `scheduled-tasks install`
 * for a ready-to-paste block).
 *
 * Run: npx tsx examples/16-scheduled-tasks.ts
 */

import {
  createAgent,
  runScheduledTask,
  generateCrontabEntries,
  parseCron,
  cronMatches,
  type ScheduledTask,
} from 'agent-do';
import { createMockModel } from 'agent-do/testing';

console.log('═══════════════════════════════════════');
console.log('  Example 16: Scheduled Tasks');
console.log('═══════════════════════════════════════\n');

const scheduledTasks: ScheduledTask[] = [
  {
    id: 'ea-sweep',
    cron: '*/15 8-21 * * *',
    payload: 'Run the inbox-triage routine.',
    description: 'Every 15 minutes during the day, triage the inbox.',
  },
  {
    id: 'daily-prep',
    cron: '0 2 * * *',
    sessionTarget: 'isolated',
    wakeMode: 'systemEvent',
    payload: { event: 'daily-prep' },
    description: 'Daily prep at 2am',
  },
];

const agent = createAgent({
  id: 'ea',
  name: 'EA',
  // Stand-in model so the example doesn't need credentials.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: createMockModel({
    responses: [{ text: 'Sweep complete. 3 items triaged.' }],
  }) as any,
  systemPrompt: 'You are an executive assistant.',
  scheduledTasks,
});

// --- Fire one task directly ----------------------------------------------
// This is what a crontab entry running `agent-do scheduled-tasks run ea-sweep`
// does under the hood. Lock files prevent overlap with any previous run.
const outcome = await runScheduledTask(agent, scheduledTasks[0]);
console.log('One-shot task outcome:');
console.log('  status:   ', outcome.status);
if (outcome.status === 'success') {
  console.log('  duration: ', outcome.durationMs, 'ms');
  console.log('  output:   ', outcome.output.slice(0, 80));
}
console.log();

// --- Evaluate the cron schedule without actually running -----------------
// Useful for tests, dashboards, or a "when does this next fire?" view.
console.log('Would these tasks fire right now?');
for (const task of scheduledTasks) {
  const parsed = parseCron(task.cron);
  const matches = cronMatches(parsed, new Date());
  console.log(`  ${task.id.padEnd(12)} ${task.cron.padEnd(20)} ${matches ? 'yes' : 'no'}`);
}
console.log();

// --- Generate a crontab block --------------------------------------------
console.log('Crontab entries you can paste into `crontab -e`:\n');
console.log(
  generateCrontabEntries(scheduledTasks, {
    cliPath: 'agent-do',
    workingDir: process.cwd(),
    extraArgs: ['--script', './ea.ts', '--yes'],
  }),
);
