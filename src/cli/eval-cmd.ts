/**
 * Eval command — run eval cases from a file or directory.
 *
 * Usage:
 *   npx agent-do eval evals/basic.ts
 *   npx agent-do eval evals/
 *   npx agent-do eval evals/basic.ts --compare anthropic,google
 *   npx agent-do eval evals/basic.ts --output json
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { ParsedArgs } from './args.js';
import { resolveModel, resolveCompareProviders } from './resolve-model.js';
import { emitSandboxWarning } from './warnings.js';
import { runEvals } from '../eval/runner.js';
import type { EvalSuiteConfig, RunEvalsOptions } from '../eval/types.js';

export async function runEvalMode(args: ParsedArgs): Promise<void> {
  if (!args.file) {
    throw new Error('Usage: npx agent-do eval <file|dir>');
  }

  // Eval suites can define their own tools per case, so the truth is
  // suite-dependent. The CLI flags are a reasonable upper bound — if the
  // user passed `--no-tools`, file access is genuinely off everywhere;
  // otherwise we warn so an operator running an unfamiliar suite isn't
  // surprised by file mutations.
  emitSandboxWarning({
    toolsEnabled: !args.noTools,
    readOnly: args.readOnly,
    json: args.json,
  });

  const target = path.resolve(args.file);
  const suites = await loadSuites(target);

  if (suites.length === 0) {
    throw new Error(`No eval suites found in "${args.file}"`);
  }

  // Determine if CLI explicitly specifies a provider/model override
  const hasCliModelOverride = !!args.model || args.provider !== 'anthropic';

  // For structured output (json/csv) with multiple suites, suppress per-suite
  // output and emit one combined document at the end
  const isStructured = args.output === 'json' || args.output === 'csv';
  const multiSuite = suites.length > 1;

  let hasFailures = false;
  const allResults: import('../eval/types.js').EvalResult[] = [];

  for (const suite of suites) {
    // Build per-suite options to preserve each suite's own model
    const options: RunEvalsOptions = {
      output: (isStructured && multiSuite) ? 'silent' : args.output,
      concurrency: args.concurrency,
    };

    // Multi-provider comparison
    if (args.compare && args.compare.length > 0) {
      options.providers = await resolveCompareProviders(args.compare, args.model);
    } else if (hasCliModelOverride) {
      options.model = await resolveModel(args.provider, args.model);
    } else if (!suite.model) {
      options.model = await resolveModel(args.provider, args.model);
    }

    const result = await runEvals(suite, options);
    allResults.push(result);
    if (result.providers.some(p => p.failed > 0)) {
      hasFailures = true;
    }
  }

  // Emit combined structured output for multi-suite runs
  if (isStructured && multiSuite) {
    if (args.output === 'json') {
      console.log(JSON.stringify(allResults, null, 2));
    } else {
      // CSV: emit header once, then rows from all results
      const lines = ['timestamp,suite,provider,model,case,passed,cost_usd,duration_ms,steps,error'];
      for (const result of allResults) {
        for (const provider of result.providers) {
          for (const c of provider.cases) {
            lines.push([
              result.timestamp,
              csvEscape(result.name),
              csvEscape(provider.provider),
              csvEscape(provider.model),
              csvEscape(c.name),
              c.passed,
              c.cost.toFixed(6),
              c.durationMs,
              c.steps,
              csvEscape(c.error ?? ''),
            ].join(','));
          }
        }
      }
      console.log(lines.join('\n'));
    }
  }

  if (hasFailures) {
    process.exit(1);
  }
}

async function loadSuites(target: string): Promise<EvalSuiteConfig[]> {
  const stat = await fs.promises.stat(target).catch(() => null);

  if (!stat) {
    throw new Error(`File or directory not found: ${target}`);
  }

  if (stat.isFile()) {
    return [await loadSuiteFile(target)];
  }

  if (stat.isDirectory()) {
    const files = await fs.promises.readdir(target);
    const evalFiles = files.filter(f => /\.(ts|js|mjs|mts)$/.test(f));

    if (evalFiles.length === 0) {
      throw new Error(`No .ts or .js files found in "${target}"`);
    }

    const suites: EvalSuiteConfig[] = [];
    for (const file of evalFiles.sort()) {
      suites.push(await loadSuiteFile(path.join(target, file)));
    }
    return suites;
  }

  throw new Error(`"${target}" is not a file or directory`);
}

async function loadSuiteFile(filePath: string): Promise<EvalSuiteConfig> {
  let mod: Record<string, unknown>;
  try {
    // Use file URL for cross-platform compatibility (Windows paths)
    mod = await import(pathToFileURL(filePath).href);
  } catch (err) {
    throw new Error(
      `Failed to import eval file "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const suite = (mod.default ?? mod) as EvalSuiteConfig;

  if (!suite.name || !Array.isArray(suite.cases)) {
    throw new Error(
      `Eval file "${filePath}" must export a config with 'name' and 'cases'. ` +
      `Use defineEval() from 'agent-do/eval'.`,
    );
  }

  return suite;
}

function csvEscape(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
