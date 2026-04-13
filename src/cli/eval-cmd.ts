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
import type { ParsedArgs } from './args.js';
import { resolveModel, resolveCompareProviders } from './resolve-model.js';
import { runEvals } from '../eval/runner.js';
import type { EvalSuiteConfig, RunEvalsOptions } from '../eval/types.js';

export async function runEvalMode(args: ParsedArgs): Promise<void> {
  if (!args.file) {
    throw new Error('Usage: npx agent-do eval <file|dir>');
  }

  const target = path.resolve(args.file);
  const suites = await loadSuites(target);

  if (suites.length === 0) {
    throw new Error(`No eval suites found in "${args.file}"`);
  }

  // Build run options
  const options: RunEvalsOptions = {
    output: args.output,
    concurrency: args.concurrency,
  };

  // Multi-provider comparison
  if (args.compare && args.compare.length > 0) {
    options.providers = await resolveCompareProviders(args.compare, args.model);
  } else {
    // Single model — override if CLI specifies provider/model, or use suite's model
    const needsModel = suites.some(s => !s.model);
    if (args.model || needsModel) {
      options.model = await resolveModel(args.provider, args.model);
    }
  }

  let hasFailures = false;

  for (const suite of suites) {
    const result = await runEvals(suite, options);
    if (result.providers.some(p => p.failed > 0)) {
      hasFailures = true;
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
    mod = await import(filePath);
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
