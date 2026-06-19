/**
 * Eval harness — two cost tiers.
 *
 *   npm run eval          → mock tier (deterministic, free, CI-safe)
 *   npm run eval:live     → live tier (real provider, real cost, opt-in)
 *
 * Mock tier: each case in `behaviour.ts` runs against a fresh
 * `createMockModel()` with its own scripted responses, via the real
 * `runEvals` + `runAgentLoop` path. Free; no API key needed.
 *
 * Live tier: runs `quality.live.ts` against a real model resolved through
 * the CLI's provider resolution (same env surface as `npx agent-do`).
 * Skipped with a clear message when no API key is present.
 *
 * Exit code is non-zero if any case fails — safe to gate CI / hooks on.
 */
import { defineEval, runEvals, type EvalResult } from '../src/eval/index.js';
import { createMockModel } from '../src/testing/index.js';
import { MOCK_CASES, MOCK_SYSTEM_PROMPT, MOCK_PRICING } from './behaviour.js';
import { LIVE_CASES, LIVE_SYSTEM_PROMPT } from './quality.live.js';

const live = process.argv.includes('--live');

// ── Mock tier ────────────────────────────────────────────────────────

async function runMockTier(): Promise<boolean> {
  console.log('\n── Mock tier (deterministic · no API calls) ──\n');

  let passed = 0;
  let failed = 0;

  for (const c of MOCK_CASES) {
    // Fresh mock per case → no cross-case queue coupling.
    const model = createMockModel({ responses: c.responses, modelId: 'mock-eval' });

    const suite = defineEval({
      name: `mock/${c.name}`,
      systemPrompt: MOCK_SYSTEM_PROMPT,
      model,
      pricing: MOCK_PRICING,
      cases: [{ name: c.name, input: c.input, assert: c.assert, runs: c.runs }],
    });

    const res: EvalResult = await runEvals(suite, { output: 'silent' });
    const caseResult = res.providers[0]!.cases[0]!;

    const icon = caseResult.passed ? '✓' : '✗';
    const status = caseResult.passed ? 'PASS' : 'FAIL';
    console.log(`  ${icon} ${status}  ${c.name}  (${caseResult.steps} steps)`);

    if (!caseResult.passed) {
      if (caseResult.error) console.log(`         error: ${caseResult.error}`);
      for (const a of caseResult.assertions.filter(a => !a.passed)) {
        console.log(`         ✗ ${a.message}`);
      }
    }

    if (caseResult.passed) passed++;
    else failed++;
  }

  console.log(`\n  mock tier: ${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

// ── Live tier ────────────────────────────────────────────────────────

async function runLiveTier(): Promise<boolean> {
  const provider = process.env.EVAL_PROVIDER ?? 'anthropic';
  const modelId = process.env.EVAL_MODEL; // provider default if unset

  const { resolveModel } = await import('../src/cli/resolve-model.js');

  let model;
  try {
    model = await resolveModel(provider, modelId);
  } catch (err) {
    console.log(
      `\n  live tier skipped: ${(err as Error).message}\n` +
      `  set an API key (e.g. ANTHROPIC_API_KEY) to run it.\n`,
    );
    // Skipping is not a failure — the mock tier is the gate.
    return true;
  }

  console.log(`\n── Live tier (${provider}${modelId ? '/' + modelId : ''}) · REAL API CALLS · costs money ──\n`);

  const suite = defineEval({
    name: 'quality-live',
    systemPrompt: LIVE_SYSTEM_PROMPT,
    model,
    cases: LIVE_CASES,
  });

  // The eval reporter prints its own table for the live tier.
  const res = await runEvals(suite, { output: 'console' });
  const anyFailed = res.providers.some(p => p.failed > 0);
  return !anyFailed;
}

// ── main ─────────────────────────────────────────────────────────────

const ok = live ? await runLiveTier() : await runMockTier();
process.exit(ok ? 0 : 1);
