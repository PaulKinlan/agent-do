/**
 * Assertion evaluation logic.
 *
 * Each assertion type has a corresponding evaluator that takes
 * the CaseRunResult and returns an AssertionResult.
 */

import { generateText, type LanguageModel } from 'ai';
import type {
  Assertion,
  AssertionResult,
  CaseRunResult,
} from './types.js';

/**
 * Evaluate a single assertion against a case run result.
 */
export async function evaluateAssertion(
  assertion: Assertion,
  result: CaseRunResult,
  judgeModel?: LanguageModel,
): Promise<AssertionResult> {
  switch (assertion.type) {
    case 'contains':
      return evaluateContains(assertion.value, result.text);

    case 'not-contains':
      return evaluateNotContains(assertion.value, result.text);

    case 'regex':
      return evaluateRegex(assertion.pattern, assertion.flags, result.text);

    case 'json-schema':
      return evaluateJsonSchema(assertion.schema, result.text);

    case 'tool-called':
      return evaluateToolCalled(assertion.tool, result.toolCalls);

    case 'tool-not-called':
      return evaluateToolNotCalled(assertion.tool, result.toolCalls);

    case 'tool-args':
      return evaluateToolArgs(assertion.tool, assertion.args, result.toolCalls);

    case 'file-exists':
      return await evaluateFileExists(assertion.path, result.store, result.agentId);

    case 'file-contains':
      return await evaluateFileContains(assertion.path, assertion.value, result.store, result.agentId);

    case 'max-steps':
      return evaluateMaxSteps(assertion.max, result.steps);

    case 'max-cost':
      return evaluateMaxCost(assertion.maxUsd, result.cost);

    case 'llm-rubric':
      return await evaluateLlmRubric(
        assertion.rubric,
        assertion.score ?? 'pass-fail',
        result.text,
        assertion.judgeModel ?? judgeModel,
      );

    case 'custom':
      return await evaluateCustom(assertion.name, assertion.fn, result);

    default: {
      const _exhaustive: never = assertion;
      return { assertion: _exhaustive, passed: false, message: `Unknown assertion type` };
    }
  }
}

// ── Individual evaluators ──

function evaluateContains(value: string, text: string): AssertionResult {
  const passed = text.includes(value);
  return {
    assertion: { type: 'contains', value },
    passed,
    message: passed
      ? `Response contains "${truncate(value)}"`
      : `Response does not contain "${truncate(value)}"`,
  };
}

function evaluateNotContains(value: string, text: string): AssertionResult {
  const passed = !text.includes(value);
  return {
    assertion: { type: 'not-contains', value },
    passed,
    message: passed
      ? `Response does not contain "${truncate(value)}"`
      : `Response contains "${truncate(value)}" (should not)`,
  };
}

function evaluateRegex(pattern: string, flags: string | undefined, text: string): AssertionResult {
  let passed: boolean;
  let message: string;
  try {
    const re = new RegExp(pattern, flags);
    passed = re.test(text);
    message = passed
      ? `Response matches /${pattern}/${flags ?? ''}`
      : `Response does not match /${pattern}/${flags ?? ''}`;
  } catch (err) {
    passed = false;
    message = `Invalid regex /${pattern}/${flags ?? ''}: ${err instanceof Error ? err.message : String(err)}`;
  }
  return { assertion: { type: 'regex', pattern, flags }, passed, message };
}

function evaluateJsonSchema(schema: Record<string, unknown>, text: string): AssertionResult {
  // Simple structural validation — checks type and required fields.
  // Not a full JSON Schema validator; covers common use cases.
  try {
    const parsed = JSON.parse(text);
    const errors = validateJsonStructure(parsed, schema, '');
    const passed = errors.length === 0;
    return {
      assertion: { type: 'json-schema', schema },
      passed,
      message: passed
        ? 'Response is valid JSON matching schema'
        : `JSON schema validation failed: ${errors.join('; ')}`,
    };
  } catch {
    return {
      assertion: { type: 'json-schema', schema },
      passed: false,
      message: 'Response is not valid JSON',
    };
  }
}

function validateJsonStructure(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
): string[] {
  const errors: string[] = [];
  const expectedType = schema.type as string | undefined;

  if (expectedType) {
    // null is typeof 'object' in JS but should not match 'object' schema
    const actualType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (actualType !== expectedType) {
      errors.push(`${path || 'root'}: expected ${expectedType}, got ${actualType}`);
      return errors;
    }
  }

  if (expectedType === 'object' && typeof value === 'object' && value !== null) {
    const required = (schema.required ?? []) as string[];
    for (const key of required) {
      if (!(key in (value as Record<string, unknown>))) {
        errors.push(`${path ? path + '.' : ''}${key}: required field missing`);
      }
    }
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    if (properties) {
      for (const [key, propSchema] of Object.entries(properties)) {
        if (key in (value as Record<string, unknown>)) {
          errors.push(...validateJsonStructure((value as Record<string, unknown>)[key], propSchema, `${path ? path + '.' : ''}${key}`));
        }
      }
    }
  }

  return errors;
}

function evaluateToolCalled(
  toolName: string,
  toolCalls: CaseRunResult['toolCalls'],
): AssertionResult {
  const passed = toolCalls.some(tc => tc.toolName === toolName);
  return {
    assertion: { type: 'tool-called', tool: toolName },
    passed,
    message: passed
      ? `Tool "${toolName}" was called`
      : `Tool "${toolName}" was not called. Called: ${toolCalls.map(tc => tc.toolName).join(', ') || '(none)'}`,
  };
}

function evaluateToolNotCalled(
  toolName: string,
  toolCalls: CaseRunResult['toolCalls'],
): AssertionResult {
  const passed = !toolCalls.some(tc => tc.toolName === toolName);
  return {
    assertion: { type: 'tool-not-called', tool: toolName },
    passed,
    message: passed
      ? `Tool "${toolName}" was not called`
      : `Tool "${toolName}" was called (should not have been)`,
  };
}

function evaluateToolArgs(
  toolName: string,
  expectedArgs: Record<string, unknown>,
  toolCalls: CaseRunResult['toolCalls'],
): AssertionResult {
  const calls = toolCalls.filter(tc => tc.toolName === toolName);
  if (calls.length === 0) {
    return {
      assertion: { type: 'tool-args', tool: toolName, args: expectedArgs },
      passed: false,
      message: `Tool "${toolName}" was not called`,
    };
  }

  // Check if any call has matching args (deep partial match)
  const passed = calls.some(call => {
    const actualArgs = call.args as Record<string, unknown>;
    return deepPartialMatch(actualArgs, expectedArgs);
  });

  return {
    assertion: { type: 'tool-args', tool: toolName, args: expectedArgs },
    passed,
    message: passed
      ? `Tool "${toolName}" was called with expected args`
      : `Tool "${toolName}" was called but args did not match. Got: ${JSON.stringify(calls.map(c => c.args))}`,
  };
}

async function evaluateFileExists(
  path: string,
  store: import('../stores.js').MemoryStore,
  agentId: string,
): Promise<AssertionResult> {
  try {
    const exists = await store.exists(agentId, path);
    return {
      assertion: { type: 'file-exists', path },
      passed: exists,
      message: exists
        ? `File "${path}" exists`
        : `File "${path}" does not exist`,
    };
  } catch {
    return {
      assertion: { type: 'file-exists', path },
      passed: false,
      message: `Error checking if file "${path}" exists`,
    };
  }
}

async function evaluateFileContains(
  path: string,
  value: string,
  store: import('../stores.js').MemoryStore,
  agentId: string,
): Promise<AssertionResult> {
  try {
    const content = await store.read(agentId, path);
    const passed = content.includes(value);
    return {
      assertion: { type: 'file-contains', path, value },
      passed,
      message: passed
        ? `File "${path}" contains "${truncate(value)}"`
        : `File "${path}" does not contain "${truncate(value)}"`,
    };
  } catch {
    return {
      assertion: { type: 'file-contains', path, value },
      passed: false,
      message: `File "${path}" does not exist or could not be read`,
    };
  }
}

function evaluateMaxSteps(max: number, actual: number): AssertionResult {
  const passed = actual <= max;
  return {
    assertion: { type: 'max-steps', max },
    passed,
    message: passed
      ? `Completed in ${actual} steps (max: ${max})`
      : `Took ${actual} steps (max: ${max})`,
  };
}

function evaluateMaxCost(maxUsd: number, actual: number): AssertionResult {
  const passed = actual <= maxUsd;
  return {
    assertion: { type: 'max-cost', maxUsd },
    passed,
    message: passed
      ? `Cost $${actual.toFixed(4)} (max: $${maxUsd.toFixed(4)})`
      : `Cost $${actual.toFixed(4)} exceeds max $${maxUsd.toFixed(4)}`,
  };
}

async function evaluateLlmRubric(
  rubric: string,
  scoreType: 'pass-fail' | '1-5',
  text: string,
  model?: LanguageModel,
): Promise<AssertionResult> {
  if (!model) {
    return {
      assertion: { type: 'llm-rubric', rubric, score: scoreType },
      passed: false,
      message: 'No judge model available for llm-rubric assertion. Provide a model in the eval suite or assertion.',
    };
  }

  const scorePrompt = scoreType === 'pass-fail'
    ? `Respond with exactly "PASS" or "FAIL" on the first line, followed by a brief explanation.`
    : `Respond with a score from 1 to 5 on the first line (where 5 is best), followed by a brief explanation.`;

  try {
    const result = await generateText({
      model,
      messages: [
        {
          role: 'user',
          content: `You are evaluating an AI assistant's response against a rubric.

## Rubric
${rubric}

## Response to evaluate
${text}

## Instructions
${scorePrompt}`,
        },
      ],
    });

    const judgeResponse = result.text.trim();
    const firstLine = judgeResponse.split('\n')[0]?.trim().toUpperCase() ?? '';

    if (scoreType === 'pass-fail') {
      const passed = firstLine === 'PASS';
      return {
        assertion: { type: 'llm-rubric', rubric, score: scoreType },
        passed,
        message: `LLM judge: ${judgeResponse.slice(0, 200)}`,
      };
    } else {
      const score = parseInt(firstLine, 10);
      const passed = !isNaN(score) && score >= 3;
      return {
        assertion: { type: 'llm-rubric', rubric, score: scoreType },
        passed,
        message: `LLM judge score: ${score}/5 — ${judgeResponse.slice(0, 200)}`,
      };
    }
  } catch (err) {
    return {
      assertion: { type: 'llm-rubric', rubric, score: scoreType },
      passed: false,
      message: `LLM judge error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function evaluateCustom(
  name: string,
  fn: (result: CaseRunResult) => boolean | Promise<boolean>,
  result: CaseRunResult,
): Promise<AssertionResult> {
  try {
    const passed = await fn(result);
    return {
      assertion: { type: 'custom', name, fn },
      passed,
      message: passed ? `Custom "${name}": passed` : `Custom "${name}": failed`,
    };
  } catch (err) {
    return {
      assertion: { type: 'custom', name, fn },
      passed: false,
      message: `Custom "${name}" threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Helpers ──

function truncate(s: string, max = 50): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

/**
 * Deep partial match — every key/value in `expected` must match in `actual`.
 * Recurses into objects and arrays. Primitives compared with strict equality.
 */
function deepPartialMatch(actual: unknown, expected: unknown): boolean {
  // Primitives — strict equality
  if (expected === null || expected === undefined || typeof expected !== 'object') {
    return actual === expected;
  }

  // Array match — expected array must match actual array element-by-element
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    if (expected.length !== actual.length) return false;
    return expected.every((item, i) => deepPartialMatch(actual[i], item));
  }

  // Object partial match — every key in expected must exist and match in actual
  if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) {
    return false;
  }

  const actualObj = actual as Record<string, unknown>;
  const expectedObj = expected as Record<string, unknown>;

  return Object.keys(expectedObj).every(key =>
    key in actualObj && deepPartialMatch(actualObj[key], expectedObj[key]),
  );
}
