/**
 * Demo: Chief of Staff
 *
 * A "founder's chief of staff" — master agent coordinates three
 * specialists (Executive Assistant, Business Development, Task Manager)
 * against a shared workspace of markdown files.
 *
 * This demo shows the *shape* of the clawchief pattern adapted to
 * agent-do — policy modules as markdown injected into the system
 * prompt, deterministic handoffs between roles, and a single
 * source-of-truth workspace each role reads before acting.
 *
 * Running the demo creates a workspace in ./sandbox/ with seed files:
 *   - priority-map.md      (policy: who/what matters, P0-P3 levels)
 *   - auto-resolver.md     (policy: when to act vs escalate)
 *   - inbox.md             (mock inbox — replace with Gmail MCP later)
 *   - tracker.md           (BD lead tracker)
 *   - tasks.md             (live TODO list)
 *
 * Run:
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   npm start
 *   # Or pass a specific instruction:
 *   npm start "Triage the inbox and add follow-ups to tasks.md"
 */

import * as readline from 'node:readline';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createOrchestrator,
  createFileTools,
} from 'agent-do';
import { FilesystemMemoryStore } from 'agent-do/stores/filesystem';
import { resolveProvider, announce } from './provider.js';

// ═══════════════════════════════════════════════
//  Configuration
// ═══════════════════════════════════════════════

const SANDBOX_DIR = resolve('sandbox');

// Resolve provider from env — Anthropic / Google / OpenAI. See
// ./provider.ts for DEMO_PROVIDER + per-provider key vars.
const resolved = await resolveProvider();

// ═══════════════════════════════════════════════
//  Seed the workspace on first run
// ═══════════════════════════════════════════════

mkdirSync(SANDBOX_DIR, { recursive: true });

function seed(filename: string, content: string): void {
  const path = resolve(SANDBOX_DIR, filename);
  if (!existsSync(path)) {
    writeFileSync(path, content, 'utf8');
    console.log(`  seeded: ${filename}`);
  }
}

const PRIORITY_MAP = `# Priority Map

Ordering rules for what gets the chief of staff's attention first.

## Levels
- **P0 (drop everything):** CEO, board, regulators, security incidents, legal notices
- **P1 (same day):** direct reports, active customers, active deals > $50K
- **P2 (this week):** prospects, vendors, partner check-ins, newsletter signups
- **P3 (when time permits):** cold outreach, PR pitches, generic recruiter mail

## Routing rules (signal → handoff)
- New lead or outreach → delegate to **business-development**
- Calendar / scheduling request → delegate to **executive-assistant**
- New TODO or status update → delegate to **task-manager**
- Any P0 → surface to the principal immediately, do not auto-resolve
`;

const AUTO_RESOLVER = `# Auto-resolver

How the chief of staff decides to act on each signal. Four modes:

- **auto-resolve:** act without asking (P2/P3 informational, out-of-office replies, calendar confirmations matching a standing preference)
- **draft-and-ask:** write the reply/action but wait for approval (P1 customer replies, new commitments, anything touching money)
- **escalate:** surface directly to the principal, do not draft (P0 items, conflicts in priority-map, legal/compliance signals)
- **ignore:** filter spam, confirmed duplicates, no-reply newsletters

## Source-of-truth rule
Never auto-resolve from memory alone. Always re-read the current state of inbox.md / tracker.md / tasks.md before acting. If a file disagrees with what you remember, trust the file.
`;

const INBOX = `# Inbox (mock)

- [ ] (P0) CEO: "Can you pull together the board deck updates by EOD Friday?"
- [ ] (P1) Alice Chen (alice@bigcustomer.com): "We're hitting 500 errors on the /export endpoint since last Tuesday. Can we jump on a call?"
- [ ] (P2) Recruiter at Talent.co: "Have a senior staff eng role you might be interested in"
- [ ] (P2) Stripe: "Monthly billing statement is ready"
- [ ] (P3) Cold pitch: "AI SDR tool, 30% close rate, demo Tuesday?"
- [ ] (P1) Bob Smith (bob@newprospect.io): "Saw your talk at Conf '26 — would love 30 mins to explore a partnership"
`;

const TRACKER = `# BD Tracker

| Lead | Company | Status | Next touch | Owner |
|------|---------|--------|-----------|-------|
| Alice Chen | BigCustomer Inc | Active customer, urgent issue | Reply today | Principal |
| Bob Smith | NewProspect.io | Inbound interest | Schedule intro | EA |
`;

const TASKS = `# Tasks

## Principal
- [ ] Update board deck (due Fri)
- [ ] Review Q2 hiring plan
- [ ] Renew passport

## Assistant
- [ ] Schedule Bob Smith intro
- [ ] File Stripe statement
`;

console.log('=======================================================');
console.log('  Chief of Staff demo');
console.log('=======================================================\n');
announce(resolved);
console.log(`  Workspace: ${SANDBOX_DIR}`);

seed('priority-map.md', PRIORITY_MAP);
seed('auto-resolver.md', AUTO_RESOLVER);
seed('inbox.md', INBOX);
seed('tracker.md', TRACKER);
seed('tasks.md', TASKS);

// ═══════════════════════════════════════════════
//  File stores (workspace tools for each role)
// ═══════════════════════════════════════════════

// FilesystemMemoryStore scopes paths to `{baseDir}/{agentId}/`. Using
// `agentId: ''` puts all roles at the workspace root — which is what we
// want here because every specialist reads/writes the same shared
// files (priority-map.md, inbox.md, tracker.md, tasks.md) seeded above.
// Binding to 'master' would send reads/writes to `sandbox/master/*`,
// missing the seeded source-of-truth files entirely.
const store = new FilesystemMemoryStore(SANDBOX_DIR);
const masterFileTools = createFileTools(store, '');
const eaFileTools = createFileTools(store, '');
const bdFileTools = createFileTools(store, '');
const taskFileTools = createFileTools(store, '');

// ═══════════════════════════════════════════════
//  Build the orchestrator
// ═══════════════════════════════════════════════

const policyPreamble = `Before acting, read priority-map.md and auto-resolver.md. They
define the rules for what to do with each signal. Ground every
decision in the actual contents of inbox.md / tracker.md / tasks.md —
do not resolve from memory alone.`;

const orchestrator = createOrchestrator({
  master: {
    id: 'master',
    name: 'Chief of Staff',
    model: resolved.model(resolved.defaults.master),
    systemPrompt: `You are the principal's chief of staff, coordinating three specialists against a shared workspace.

${policyPreamble}

Your specialists:
- **executive-assistant**: inbox triage, scheduling, meeting notes. Classifies every inbox item into one of P0/P1/P2/P3 and one of auto-resolve/draft-and-ask/escalate/ignore.
- **business-development**: lead tracking, follow-up cadence, outreach. Owns tracker.md.
- **task-manager**: keeps tasks.md up to date. Handles new action items, completions, and archival.

Workflow:
1. Re-read priority-map.md and auto-resolver.md at the start of every run.
2. Read whichever of inbox.md / tracker.md / tasks.md is relevant.
3. Delegate to ONE specialist per sub-task via delegate_task (pass the specialist the file contents they need).
4. Consolidate their outputs, write updates back to the workspace, and summarise what changed.

Silence contract: if there is nothing actionable in this run, respond with "OK" and do not call any tools.`,
    tools: masterFileTools,
    maxIterations: 10,
    hooks: {
      onPreToolUse: async (event) => {
        if (event.toolName === 'delegate_task') {
          const args = event.args as { agentId: string; task: string };
          const preview = args.task.slice(0, 100);
          console.log(`  >> master → ${args.agentId}: ${preview}${args.task.length > 100 ? '...' : ''}`);
        } else if (event.toolName === 'write_file') {
          const args = event.args as { path: string };
          console.log(`  >> master updating ${args.path}`);
        }
        return { decision: 'allow' };
      },
      onComplete: async (event) => {
        console.log('');
        console.log('-------------------------------------------------------');
        console.log(`  done — ${event.totalSteps} steps, $${event.usage.totalCost.toFixed(4)}`);
      },
    },
    usage: { enabled: true },
  },
  workers: [
    {
      id: 'executive-assistant',
      name: 'Executive Assistant',
      model: resolved.model(resolved.defaults.worker),
      systemPrompt: `You are the principal's executive assistant. You triage the inbox and handle scheduling.

${policyPreamble}

Deliverables:
- For each inbox item: classify priority (P0-P3) and resolution mode (auto-resolve / draft-and-ask / escalate / ignore) per auto-resolver.md.
- Produce a structured summary with three sections: "Escalate now", "Draft reply (needs approval)", "Auto-resolved".
- NEVER send replies directly — draft and ask.`,
      tools: eaFileTools,
      maxIterations: 3,
    },
    {
      id: 'business-development',
      name: 'Business Development',
      model: resolved.model(resolved.defaults.worker),
      systemPrompt: `You are the principal's BD / CRM owner.

${policyPreamble}

Deliverables:
- New leads from the inbox or handed off from EA → append a row to tracker.md with initial status + next-touch date.
- Apply follow-up cadence: 2 days after first touch, 5 days after second, 7 days after third; stop after 3.
- Return a short report of what you added or updated.

Defer to executive-assistant when a signal is scheduling/calendar-only.`,
      tools: bdFileTools,
      maxIterations: 3,
    },
    {
      id: 'task-manager',
      name: 'Task Manager',
      model: resolved.model(resolved.defaults.worker),
      systemPrompt: `You are the principal's task manager. You own tasks.md.

${policyPreamble}

Deliverables:
- New action items → append under the correct owner section (Principal / Assistant).
- Completions → check the box and move to a "Completed" section at the bottom.
- Return the updated tasks.md content after your edits.`,
      tools: taskFileTools,
      maxIterations: 3,
    },
  ],
});

// ═══════════════════════════════════════════════
//  Run
// ═══════════════════════════════════════════════

async function getInstruction(): Promise<string> {
  const args = process.argv.slice(2);
  if (args.length > 0) return args.join(' ');
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question('\n  What should the chief of staff work on? ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const instruction =
  (await getInstruction()) ||
  'Do a standard pass: triage the inbox, update the BD tracker with any new leads, and keep tasks.md current.';

console.log('');
console.log('=======================================================');
console.log('  Instruction');
console.log('=======================================================');
console.log(`  ${instruction}\n`);

let finalText = '';
for await (const event of orchestrator.stream(instruction)) {
  switch (event.type) {
    case 'text':
      finalText += event.content;
      break;
    case 'error':
      console.log(`  [error] ${event.content}`);
      break;
  }
}

console.log('');
console.log('=======================================================');
console.log('  Chief of Staff report');
console.log('=======================================================');
console.log(finalText);
console.log('');
console.log(`  Workspace (check your changes): ${SANDBOX_DIR}`);
