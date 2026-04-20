/**
 * Demo: Engineering Team
 *
 * A sprint-ordered pipeline of specialist roles that runs a single
 * feature request from "idea" to "ship plan" — inspired by
 * garrytan/gstack's engineering-team taxonomy. Master coordinates the
 * phases; each phase has one specialist that produces an artifact
 * the next phase consumes.
 *
 * Pipeline:
 *   Think    — office-hours         (6 forcing questions → design doc)
 *   Plan     — plan-eng-review      (ASCII diagrams, edge cases, test matrix)
 *   Review   — investigate          ("Iron Law: no fixes without investigation")
 *   Test     — qa                   (red-team the plan, list holes)
 *   Ship     — release-engineer     (rollout, canary, rollback plan)
 *
 * The demo writes intermediate + final artifacts to ./sprint/.
 *
 * Run:
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   npm start "Add an audit log for write operations"
 *   npm start   # prompts for a feature
 */

import * as readline from 'node:readline';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createOrchestrator, createFileTools } from 'agent-do';
import { FilesystemMemoryStore } from 'agent-do/stores/filesystem';
import { createAnthropic } from '@ai-sdk/anthropic';

// ═══════════════════════════════════════════════
//  Configuration
// ═══════════════════════════════════════════════

const SPRINT_DIR = resolve('sprint');
const MASTER_MODEL = 'claude-sonnet-4-6';
const WORKER_MODEL = 'claude-haiku-4-5';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required.');
  process.exit(1);
}

const provider = createAnthropic({ apiKey });

mkdirSync(SPRINT_DIR, { recursive: true });

// `agentId: ''` mounts both master and workers at the workspace root
// (SPRINT_DIR) so every phase's artifact lands in `sprint/01-…` through
// `sprint/05-…` as documented. Binding to 'master' would send writes
// to `sprint/master/*` — the README and final console output would
// then point at the wrong place.
const store = new FilesystemMemoryStore(SPRINT_DIR);
const masterFileTools = createFileTools(store, '');
const workerFileTools = createFileTools(store, '');

// ═══════════════════════════════════════════════
//  Build the orchestrator
// ═══════════════════════════════════════════════

const orchestrator = createOrchestrator({
  master: {
    id: 'master',
    name: 'Tech Lead',
    model: provider(MASTER_MODEL) as any,
    systemPrompt: `You are the tech lead running a 5-phase engineering sprint on a single feature request.

Phases must happen in order. Each phase hands off a written artifact to the next via the shared workspace.

1. **Think** → delegate to office-hours. Output: 01-design-doc.md — answers 6 forcing questions (Who is this for? What's the smallest version that proves it? What would make this a 10x improvement? What could go wrong? What are we explicitly not doing? How will we know it worked?). Write the file.
2. **Plan** → delegate to plan-eng-review. Input: 01-design-doc.md. Output: 02-plan.md — ASCII system diagrams, edge cases, test matrix.
3. **Review** → delegate to investigate. Input: 02-plan.md. Output: 03-investigation.md — existing code paths this touches, prior bugs in the neighbourhood, load-bearing invariants. Follow the Iron Law: no fix recommendations without first investigating what's actually there.
4. **Test** → delegate to qa. Input: 02-plan.md + 03-investigation.md. Output: 04-test-plan.md — red-team the plan, identify holes, propose test cases (unit + integration + failure modes).
5. **Ship** → delegate to release-engineer. Input: all prior artifacts. Output: 05-rollout.md — staged rollout, canary metrics to watch, abort criteria, rollback plan.

After all five artifacts exist, produce a short final summary: what we're building, the top 3 risks surfaced, and the go/no-go recommendation.

Do NOT skip phases. Do NOT write the artifacts yourself — each specialist writes theirs.`,
    tools: masterFileTools,
    maxIterations: 12,
    hooks: {
      onPreToolUse: async (event) => {
        if (event.toolName === 'delegate_task') {
          const args = event.args as { agentId: string };
          console.log(`\n  ── phase: ${args.agentId} ──`);
        } else if (event.toolName === 'write_file') {
          const args = event.args as { path: string };
          console.log(`  >> master writing ${args.path}`);
        }
        return { decision: 'allow' };
      },
      onPostToolUse: async (event) => {
        if (event.toolName === 'delegate_task') {
          const args = event.args as { agentId: string };
          console.log(`     ${args.agentId} done (${event.durationMs}ms)`);
        }
      },
      onComplete: async (event) => {
        console.log('\n-------------------------------------------------------');
        console.log(`  sprint complete — ${event.totalSteps} steps, $${event.usage.totalCost.toFixed(4)}`);
      },
    },
    usage: { enabled: true },
  },
  workers: [
    {
      id: 'office-hours',
      name: 'Office Hours (Think)',
      model: provider(WORKER_MODEL) as any,
      systemPrompt: `You run "office hours" for the tech lead. You answer six forcing questions about a feature request before any design work starts.

Write 01-design-doc.md with exactly these sections:
1. Who is this for?
2. What's the smallest version that proves the hypothesis?
3. What would make this a 10x improvement (not 10%)?
4. What could go wrong? (failure modes, abuse cases)
5. What are we explicitly NOT doing? (scope fences)
6. How will we know it worked? (measurable criteria)

Be concrete. Cite specifics, not generalities.`,
      tools: workerFileTools,
      maxIterations: 3,
    },
    {
      id: 'plan-eng-review',
      name: 'Engineering Plan Review',
      model: provider(WORKER_MODEL) as any,
      systemPrompt: `You are a senior engineer doing a plan review BEFORE any code gets written.

Read 01-design-doc.md. Write 02-plan.md with:
- **System diagram** (ASCII) — components, data flow, trust boundaries.
- **Data model** — new/changed tables, columns, indices. Migration plan.
- **Edge cases** — list of at least 8. For each: detection + handling.
- **Test matrix** — unit / integration / load / failure / security. What gets tested in each layer and why.
- **Non-goals** — things this plan deliberately does not solve.

Be specific. No hand-waving.`,
      tools: workerFileTools,
      maxIterations: 3,
    },
    {
      id: 'investigate',
      name: 'Investigator',
      model: provider(WORKER_MODEL) as any,
      systemPrompt: `You are the debugger/investigator. You do not propose fixes until you understand what's there.

**Iron Law:** no recommendations without first investigating.

Read 02-plan.md. Write 03-investigation.md with:
- **Code paths this touches** — files, functions, entry points.
- **Prior art** — similar features that exist; patterns to reuse or avoid.
- **Load-bearing invariants** — things the current code assumes to be true that this plan must preserve.
- **Known bugs in the neighbourhood** — from git log / issues.
- **Risk assessment** — concrete things that could break, ranked by likelihood and blast radius.

If you can't investigate something properly, say so explicitly ("Unable to verify X without access to Y").`,
      tools: workerFileTools,
      maxIterations: 3,
    },
    {
      id: 'qa',
      name: 'QA',
      model: provider(WORKER_MODEL) as any,
      systemPrompt: `You are QA. Your job is to find the holes — red-team the plan, don't bless it.

Read 02-plan.md and 03-investigation.md. Write 04-test-plan.md with:
- **Test cases** — at least 12, mixing happy paths, edge cases, adversarial inputs, and failure-mode recovery.
- **What the plan missed** — your independent list of scenarios the plan-eng-review didn't cover.
- **Browser / OS / version matrix** if relevant.
- **Acceptance criteria** — what "done" looks like, measurable.

Lean pessimistic. If something can't be tested cheaply, flag it.`,
      tools: workerFileTools,
      maxIterations: 3,
    },
    {
      id: 'release-engineer',
      name: 'Release Engineer',
      model: provider(WORKER_MODEL) as any,
      systemPrompt: `You are the release engineer. You design the rollout plan and the rollback.

Read all prior artifacts (01-05 up to this point). Write 05-rollout.md with:
- **Stages** — canary percentage, bake time, promotion gates.
- **Metrics to watch** — specific signals, thresholds, dashboards.
- **Abort criteria** — when we stop the rollout, who decides.
- **Rollback plan** — exact steps, tested or not, data migration reversibility.
- **Comms** — who gets notified at which milestone (eng, support, customers).

The test: if this rollout goes sideways at 3 AM, could the on-call engineer execute the rollback from this doc alone? If not, rewrite until they can.`,
      tools: workerFileTools,
      maxIterations: 3,
    },
  ],
});

// ═══════════════════════════════════════════════
//  Run
// ═══════════════════════════════════════════════

async function getFeature(): Promise<string> {
  const args = process.argv.slice(2);
  if (args.length > 0) return args.join(' ');
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question('\n  What feature are we planning? ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const feature = await getFeature();

if (!feature) {
  console.error('  Error: no feature provided.');
  process.exit(1);
}

console.log('=======================================================');
console.log('  Engineering team sprint');
console.log('=======================================================');
console.log(`  Feature: ${feature}`);
console.log(`  Workspace: ${SPRINT_DIR}\n`);

const task = `Run the full 5-phase engineering sprint on this feature request:

"${feature}"

Delegate each phase to its specialist, in order. Verify each artifact exists before moving to the next phase. Produce a final summary at the end.`;

let finalText = '';
for await (const event of orchestrator.stream(task)) {
  switch (event.type) {
    case 'text':
      finalText += event.content;
      break;
    case 'error':
      console.log(`  [error] ${event.content}`);
      break;
  }
}

console.log('\n=======================================================');
console.log('  Tech lead summary');
console.log('=======================================================');
console.log(finalText);
console.log('');
console.log(`  Artifacts: ${SPRINT_DIR}/01-design-doc.md … 05-rollout.md`);
