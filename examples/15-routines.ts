/**
 * Example 15: Saved Routines
 *
 * Routines are named prompt-as-macro procedures the agent invokes
 * explicitly by id, optionally with arguments that fill `{{placeholder}}`
 * substitutions in the body. Compare to skills:
 *
 *   - Skills fire *autonomously* when their description matches a
 *     task (see example 09).
 *   - Routines fire *deterministically* when the user says "run the
 *     weekly-report routine".
 *
 * Storage lives on disk so routines persist across runs. Each run bumps
 * runCount + lastRun, enabling future agent-proposed capture ("I've
 * done this 3 times — save as a routine?").
 *
 * Run: npx tsx examples/15-routines.ts
 */

import { createAgent, FilesystemRoutineStore, parseRoutineMd } from 'agent-do';
import { createAnthropic } from '@ai-sdk/anthropic';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

console.log('═══════════════════════════════════════');
console.log('  Example 15: Saved Routines');
console.log('═══════════════════════════════════════\n');

const dir = mkdtempSync(join(tmpdir(), 'agent-do-routines-'));
console.log(`Routines directory: ${dir}\n`);

const store = new FilesystemRoutineStore(dir);

// Pre-populate with a couple of routines the user has previously saved.
await store.save(
  parseRoutineMd(
    `---
name: Triage Inbox
description: Classify inbox items into urgent / response-needed / informational / spam
inputs:
  - name: count
    optional: true
---

Triage the user's inbox:
1. Look at the most recent {{count}} messages (default: 20 if count not given)
2. Classify each into: urgent / response-needed / informational / spam
3. Summarise counts + top 3 in each bucket
`,
    'triage-inbox',
  ),
);

await store.save(
  parseRoutineMd(
    `---
name: Weekly Report
description: Summarise the last 7 daily entries into a weekly rollup
inputs:
  - name: week
---

For a weekly report covering week {{week}}:
1. Read the last 7 daily entries from entries/
2. Group key themes across: Events / People / Decisions / Open Threads
3. Write to reports/weekly-{{week}}.md
`,
    'weekly-report',
  ),
);

console.log('Pre-saved 2 routines: triage-inbox, weekly-report\n');

const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })(
  'claude-sonnet-4-6',
);

const agent = createAgent({
  id: 'assistant',
  name: 'Assistant',
  model: model as any,
  systemPrompt:
    'You are a helpful assistant. When the user asks you to run a routine by name, use the run_routine tool to retrieve and follow its instructions.',
  routines: store,
  maxIterations: 5,
});

console.log('Task: "Run the weekly-report routine for week 17."\n');
console.log('The agent should:');
console.log('  1. Call list_routines (or go directly to run_routine)');
console.log('  2. Call run_routine with routineId="weekly-report", args={week: "17"}');
console.log('  3. Follow the returned instructions, with {{week}} filled as "17"\n');

const result = await agent.run('Run the weekly-report routine for week 17.');

console.log('Agent output:\n');
result.split('\n').forEach((line) => console.log(`   ${line}`));
console.log('');

// Show that runCount persisted across the run.
const after = await store.get('weekly-report');
console.log(`weekly-report runCount is now ${after?.runCount}, lastRun=${after?.lastRun}\n`);

console.log('Done — routines persist on disk, and each run bumps the counter.');
