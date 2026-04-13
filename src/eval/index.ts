/**
 * Eval framework for agent-do.
 *
 * Define eval cases, run them against real or mock models,
 * and score agent quality with assertions.
 */

export { defineEval, runEvals } from './runner.js';
export { evaluateAssertion } from './assertions.js';

export type {
  // Assertions
  Assertion,
  ContainsAssertion,
  NotContainsAssertion,
  RegexAssertion,
  JsonSchemaAssertion,
  ToolCalledAssertion,
  ToolNotCalledAssertion,
  ToolArgsAssertion,
  FileExistsAssertion,
  FileContainsAssertion,
  MaxStepsAssertion,
  MaxCostAssertion,
  LlmRubricAssertion,
  CustomAssertion,
  // Cases and suites
  EvalCase,
  EvalSuiteConfig,
  RunEvalsOptions,
  // Results
  CaseRunResult,
  AssertionResult,
  CaseResult,
  ProviderResult,
  EvalResult,
} from './types.js';
