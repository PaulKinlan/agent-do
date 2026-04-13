/**
 * Eval runner — executes eval suites and collects results.
 *
 * Handles running agent loops, collecting tool calls, evaluating
 * assertions, and producing structured results.
 */

import type { LanguageModel } from 'ai';
import type {
  EvalSuiteConfig,
  EvalCase,
  CaseRunResult,
  CaseResult,
  ProviderResult,
  EvalResult,
  RunEvalsOptions,
} from './types.js';
import { evaluateAssertion } from './assertions.js';
import { runAgentLoop } from '../loop.js';
import { createFileTools } from '../tools/file-tools.js';
import { InMemoryMemoryStore } from '../stores/in-memory.js';
import type { MemoryStore } from '../stores.js';

const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_AGENT_ID = 'eval-agent';

/**
 * Define an eval suite. This is a type-safe helper that returns
 * the config unchanged — useful for editor autocompletion.
 */
export function defineEval(config: EvalSuiteConfig): EvalSuiteConfig {
  return config;
}

/**
 * Run an eval suite and return structured results.
 *
 * Supports single-provider runs and multi-provider comparison.
 * Each case gets a fresh memory store for isolation.
 */
export async function runEvals(
  suite: EvalSuiteConfig,
  options: RunEvalsOptions = {},
): Promise<EvalResult> {
  const { output = 'console', signal } = options;

  // Determine provider list
  const providers = resolveProviders(suite, options);

  const result: EvalResult = {
    name: suite.name,
    timestamp: new Date().toISOString(),
    providers: [],
  };

  for (const provider of providers) {
    if (signal?.aborted) break;

    const providerResult = await runProviderEvals(suite, provider, options);
    result.providers.push(providerResult);
  }

  // Format output
  if (output === 'console') {
    printConsoleReport(result);
  } else if (output === 'json') {
    console.log(JSON.stringify(result, null, 2));
  } else if (output === 'csv') {
    console.log(formatCsv(result));
  }
  // 'silent' — no output

  return result;
}

// ── Internal ──

interface ResolvedProvider {
  name: string;
  model: LanguageModel;
}

function resolveProviders(
  suite: EvalSuiteConfig,
  options: RunEvalsOptions,
): ResolvedProvider[] {
  // Multi-provider comparison
  if (options.providers && options.providers.length > 0) {
    return options.providers.map(p => ({
      name: p.name,
      model: p.model,
    }));
  }

  // Single model override
  const model = options.model ?? suite.model;
  if (!model) {
    throw new Error(
      `No model provided. Set model in the eval suite config or pass it via runEvals options.`,
    );
  }

  const name = getModelName(model);
  return [{ name, model }];
}

function getModelName(model: LanguageModel): string {
  if (typeof model === 'string') return model;
  return (model as { modelId?: string }).modelId ?? 'unknown';
}

async function runProviderEvals(
  suite: EvalSuiteConfig,
  provider: ResolvedProvider,
  options: RunEvalsOptions,
): Promise<ProviderResult> {
  const startTime = Date.now();
  const cases: CaseResult[] = [];
  let totalCost = 0;

  const concurrency = options.concurrency ?? 1;

  if (concurrency <= 1) {
    // Sequential
    for (const evalCase of suite.cases) {
      if (options.signal?.aborted) break;
      const caseResult = await runCase(suite, evalCase, provider, options);
      cases.push(caseResult);
      totalCost += caseResult.cost;
    }
  } else {
    // Parallel with concurrency limit — worker pattern
    let nextCaseIndex = 0;
    const workerCount = Math.min(concurrency, suite.cases.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (!options.signal?.aborted) {
        const currentIndex = nextCaseIndex++;
        if (currentIndex >= suite.cases.length) break;

        const evalCase = suite.cases[currentIndex]!;
        const caseResult = await runCase(suite, evalCase, provider, options);
        cases.push(caseResult);
        totalCost += caseResult.cost;
      }
    });

    await Promise.all(workers);
  }

  const passed = cases.filter(c => c.passed).length;
  return {
    provider: provider.name,
    model: getModelName(provider.model),
    totalCases: cases.length,
    passed,
    failed: cases.length - passed,
    totalCost,
    durationMs: Date.now() - startTime,
    cases,
  };
}

async function runCase(
  suite: EvalSuiteConfig,
  evalCase: EvalCase,
  provider: ResolvedProvider,
  options: RunEvalsOptions,
): Promise<CaseResult> {
  const runs = evalCase.runs ?? 1;

  if (runs <= 1) {
    return runSingleCase(suite, evalCase, provider, options);
  }

  // Multi-run: run N times, report aggregate
  const runResults: CaseResult[] = [];
  for (let i = 0; i < runs; i++) {
    runResults.push(await runSingleCase(suite, evalCase, provider, options));
  }

  const allPassed = runResults.every(r => r.passed);
  const totalCost = runResults.reduce((sum, r) => sum + r.cost, 0);
  const totalDuration = runResults.reduce((sum, r) => sum + r.durationMs, 0);

  // Surface assertions from the first failing run (or first run if all passed)
  const representativeRun = runResults.find(r => !r.passed) ?? runResults[0];

  return {
    name: evalCase.name,
    input: evalCase.input,
    passed: allPassed,
    assertions: representativeRun?.assertions ?? [],
    cost: totalCost,
    durationMs: totalDuration,
    steps: Math.max(...runResults.map(r => r.steps)),
    text: representativeRun?.text ?? '',
    error: representativeRun?.error,
    runs: runResults,
  };
}

async function runSingleCase(
  suite: EvalSuiteConfig,
  evalCase: EvalCase,
  provider: ResolvedProvider,
  options: RunEvalsOptions,
): Promise<CaseResult> {
  const startTime = Date.now();
  const timeout = evalCase.timeout ?? DEFAULT_TIMEOUT;

  // Fresh store per case for isolation
  const store: MemoryStore = options.createStore?.() ?? new InMemoryMemoryStore();
  const agentId = DEFAULT_AGENT_ID;

  // Collect tool calls
  const toolCalls: CaseRunResult['toolCalls'] = [];

  // Create tools — wrap to capture tool calls
  const baseTools = suite.tools ?? createFileTools(store, agentId);
  const wrappedTools = wrapToolsForCapture(baseTools, toolCalls);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const parentAbortHandler = () => controller.abort();

  // Also respect parent signal
  if (options.signal) {
    options.signal.addEventListener('abort', parentAbortHandler, { once: true });
  }

  try {
    const result = await runAgentLoop(
      {
        id: agentId,
        name: `eval-${suite.name}`,
        model: provider.model,
        systemPrompt: suite.systemPrompt,
        tools: wrappedTools,
        maxIterations: suite.maxIterations ?? 20,
        hooks: suite.hooks,
        permissions: suite.permissions ?? { mode: 'accept-all' },
        usage: {
          enabled: true,
          pricing: suite.pricing,
        },
        signal: controller.signal,
      },
      evalCase.input,
      evalCase.context,
      evalCase.history,
    );

    const caseRunResult: CaseRunResult = {
      text: result.text,
      steps: result.steps,
      cost: result.usage.totalCost,
      durationMs: Date.now() - startTime,
      toolCalls,
      store,
      agentId,
      aborted: result.aborted,
    };

    // Evaluate assertions
    const assertions = await evaluateAllAssertions(
      evalCase.assert,
      caseRunResult,
      provider.model,
    );

    // Aborted runs always fail — partial output should not produce false positives
    const aborted = result.aborted;

    return {
      name: evalCase.name,
      input: evalCase.input,
      passed: !aborted && assertions.every(a => a.passed),
      assertions,
      cost: caseRunResult.cost,
      durationMs: caseRunResult.durationMs,
      steps: caseRunResult.steps,
      text: caseRunResult.text,
      error: aborted ? 'Agent run was aborted (timeout or signal).' : undefined,
    };
  } catch (err) {
    return {
      name: evalCase.name,
      input: evalCase.input,
      passed: false,
      assertions: [],
      cost: 0,
      durationMs: Date.now() - startTime,
      steps: 0,
      text: '',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeoutId);
    if (options.signal) {
      options.signal.removeEventListener('abort', parentAbortHandler);
    }
  }
}

function wrapToolsForCapture(
  tools: import('ai').ToolSet,
  captured: CaseRunResult['toolCalls'],
): import('ai').ToolSet {
  const wrapped: import('ai').ToolSet = {};

  for (const [name, toolDef] of Object.entries(tools)) {
    if (!toolDef || !toolDef.execute) {
      wrapped[name] = toolDef;
      continue;
    }

    const originalExecute = toolDef.execute;
    wrapped[name] = {
      ...toolDef,
      execute: async (args: unknown, context: unknown) => {
        // Record the call attempt before execution so tool-called assertions
        // work even if the tool throws
        const entry = {
          toolName: name,
          args: (args ?? {}) as Record<string, unknown>,
          result: undefined as unknown,
        };
        captured.push(entry);

        try {
          const result = await (originalExecute as Function)(args, context);
          entry.result = result;
          return result;
        } catch (error) {
          entry.result = error instanceof Error
            ? { error: error.name, message: error.message }
            : { error: 'unknown', message: String(error) };
          throw error;
        }
      },
    };
  }

  return wrapped;
}

async function evaluateAllAssertions(
  assertions: EvalCase['assert'],
  result: CaseRunResult,
  judgeModel?: LanguageModel,
) {
  const results = [];
  for (const assertion of assertions) {
    results.push(await evaluateAssertion(assertion, result, judgeModel));
  }
  return results;
}

// ── Reporters ──

function printConsoleReport(result: EvalResult): void {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Eval: ${result.name}`);
  console.log(`  Time: ${result.timestamp}`);
  console.log(`${'═'.repeat(60)}\n`);

  for (const provider of result.providers) {
    if (result.providers.length > 1) {
      console.log(`── ${provider.provider} (${provider.model}) ──`);
    }

    for (const c of provider.cases) {
      const icon = c.passed ? '✓' : '✗';
      const status = c.passed ? 'PASS' : 'FAIL';
      console.log(`  ${icon} ${status}  ${c.name}  ($${c.cost.toFixed(4)}, ${c.durationMs}ms, ${c.steps} steps)`);

      if (!c.passed) {
        if (c.error) {
          console.log(`         Error: ${c.error}`);
        }
        for (const a of c.assertions) {
          if (!a.passed) {
            console.log(`         ✗ ${a.message}`);
          }
        }
      }

      if (c.runs && c.runs.length > 1) {
        const passedRuns = c.runs.filter(r => r.passed).length;
        console.log(`         Runs: ${passedRuns}/${c.runs.length} passed`);
      }
    }

    console.log();
    console.log(`  Total: ${provider.totalCases} cases, ${provider.passed} passed, ${provider.failed} failed`);
    console.log(`  Cost:  $${provider.totalCost.toFixed(4)}`);
    console.log(`  Time:  ${provider.durationMs}ms`);
    console.log();
  }

  // Comparison table for multi-provider
  if (result.providers.length > 1) {
    printComparisonTable(result);
  }
}

function printComparisonTable(result: EvalResult): void {
  console.log(`── Comparison ──`);
  console.log();

  // Header
  const providers = result.providers;
  const nameWidth = Math.max(20, ...providers.map(p => p.provider.length + p.model.length + 3));
  const header = `  ${'Provider'.padEnd(nameWidth)}  Pass  Fail  Cost       Time`;
  console.log(header);
  console.log(`  ${'─'.repeat(header.length - 2)}`);

  for (const p of providers) {
    const name = `${p.provider} (${p.model})`;
    console.log(
      `  ${name.padEnd(nameWidth)}  ${String(p.passed).padStart(4)}  ${String(p.failed).padStart(4)}  $${p.totalCost.toFixed(4).padStart(8)}  ${String(p.durationMs).padStart(6)}ms`,
    );
  }
  console.log();
}

function formatCsv(result: EvalResult): string {
  const lines: string[] = [
    'timestamp,provider,model,case,passed,cost_usd,duration_ms,steps,error',
  ];

  for (const provider of result.providers) {
    for (const c of provider.cases) {
      lines.push(
        [
          result.timestamp,
          csvEscape(provider.provider),
          csvEscape(provider.model),
          csvEscape(c.name),
          c.passed,
          c.cost.toFixed(6),
          c.durationMs,
          c.steps,
          csvEscape(c.error ?? ''),
        ].join(','),
      );
    }
  }

  return lines.join('\n');
}

function csvEscape(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
