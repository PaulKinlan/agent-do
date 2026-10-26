/**
 * Slash-command router (#76).
 *
 * Deterministic pre-model dispatch: when a user's input starts with
 * `/<name>`, the loop routes the remainder to a configured sub-agent
 * BEFORE any model call. Routing is structural — zero LLM cost, zero
 * tool surface, no prompt round-trip.
 *
 * Contrast with the orchestrator (`src/orchestrator.ts`), where the
 * *model* decides to delegate via the `delegate_task` tool. Slash
 * commands are the *user's* deterministic path into a sub-agent.
 */

import type { Agent } from './types.js';
import type { AgentConfig, RunResult } from './types.js';

/**
 * Valid slash-command name shape. Same character class as skill /
 * routine ids. A leading `/` followed by anything not matching this
 * (e.g. a file path like `/etc/hosts`) is NOT treated as a command —
 * it falls through to the model so genuine path-shaped tasks aren't
 * swallowed by the router.
 */
const SLASH_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Hidden, non-enumerable marker stamped onto an {@link Agent} created
 * with `slashCommands`. Lets parent config validation detect nested
 * slash commands (`/a/b`) without leaking the marker into the public
 * Agent surface or JSON serialisation.
 *
 * Nested slash commands are disallowed by design: dispatch is a single
 * deterministic hop. Allowing `/a/b` would either route only on the
 * first token (surprising) or require recursively re-parsing the
 * remainder (a combinatorial escape hatch). One level keeps the
 * contract obvious.
 */
const HAS_SLASH_COMMANDS: unique symbol = Symbol('agent-do.hasSlashCommands');

export type AgentWithSlashMarker = Agent & { readonly [HAS_SLASH_COMMANDS]?: boolean };

/**
 * Parse `/<name>` + optional remainder from a task string.
 *
 * Returns `{ name, rest }` when the input (after leading-whitespace
 * trim) is a slash command: a `/`, a valid command name, then either
 * end-of-string or whitespace + free-form remainder. Returns `null`
 * otherwise — including for inputs that merely *start* with `/` but
 * are not command-shaped (file paths, a bare `/`, etc.).
 *
 * Examples:
 *   '/research quantum cryptography' → { name: 'research', rest: 'quantum cryptography' }
 *   '/review'                        → { name: 'review',    rest: '' }
 *   '/triage  a  b'                  → { name: 'triage',    rest: 'a  b' }   (inner spacing preserved)
 *   'hello'                          → null
 *   '/etc/hosts'                     → null   (name shape fails → falls through to model)
 *   '/'                              → null
 */
export function parseSlashCommand(
  input: string,
): { name: string; rest: string } | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/')) return null;
  // `/` then a valid name, then either end or whitespace + remainder.
  // Anchoring at both ends is what rejects `/etc/hosts` (the `/` after
  // `etc` is neither whitespace nor end-of-string, so the optional
  // remainder group can't consume it).
  const match = /^\/([a-zA-Z0-9_-]+)(?:[ \t\r\n]+([\s\S]*))?$/.exec(trimmed);
  if (!match || !match[1]) return null;
  return { name: match[1], rest: match[2] ?? '' };
}

/**
 * Validate an `AgentConfig.slashCommands` map at `createAgent()` time.
 *
 * Returns `null` when valid, or an error message describing the first
 * problem found. Checked in source order so the message is stable.
 *
 * Rules:
 *   - Keys must match the internal `SLASH_NAME_RE` (same character class
 *     as skill / routine ids — prevents `/` or whitespace smuggling).
 *   - Values must look like {@link Agent} instances (duck-typed on
 *     `run` / `stream` being functions; the TS type already constrains
 *     this, the runtime check catches plain-object misuse).
 *   - No value may itself carry the internal `HAS_SLASH_COMMANDS` marker —
 *     nested slash commands (`/a/b`) are disallowed. See the marker docs.
 */
export function validateSlashCommands(
  commands: Record<string, Agent> | undefined,
): string | null {
  if (commands === undefined) return null;
  if (typeof commands !== 'object' || commands === null || Array.isArray(commands)) {
    return 'slashCommands must be an object mapping command names to Agent instances.';
  }
  for (const [key, agent] of Object.entries(commands)) {
    if (!SLASH_NAME_RE.test(key)) {
      return (
        `slashCommands key "${key}" is invalid — must match /^[a-zA-Z0-9_-]+$/ ` +
        `(letters, digits, underscore, hyphen).`
      );
    }
    if (
      !agent ||
      typeof agent !== 'object' ||
      typeof (agent as Agent).run !== 'function' ||
      typeof (agent as Agent).stream !== 'function' ||
      typeof (agent as Agent).runWithResult !== 'function'
    ) {
      return `slashCommands["${key}"] must be an Agent instance (create one via createAgent()).`;
    }
    if ((agent as AgentWithSlashMarker)[HAS_SLASH_COMMANDS] === true) {
      return (
        `slashCommands["${key}"] is itself a slash-command agent. Nested slash commands ` +
        `(/a/b) are not supported — dispatch is a single deterministic hop.`
      );
    }
  }
  return null;
}

/**
 * Stamp the slash-command marker on an agent. Called by `createAgent`
 * when `config.slashCommands` is present and valid, so any parent that
 * later includes this agent in its own `slashCommands` is rejected by
 * {@link validateSlashCommands}.
 *
 * Non-enumerable so it doesn't appear in `Object.keys()`, JSON, or the
 * public Agent surface; non-writable + non-configurable so it can't be
 * accidentally stripped or forged at runtime.
 */
export function markHasSlashCommands(agent: Agent): void {
  Object.defineProperty(agent, HAS_SLASH_COMMANDS, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

/**
 * Build the "unknown command" listing returned (without calling the
 * model) when a user invokes a slash command that isn't configured.
 *
 * Sorted for determinism so the message is stable across runs / Node
 * versions (object key order is otherwise unspecified).
 */
export function unknownSlashCommandMessage(
  name: string,
  commands: Record<string, Agent> | undefined,
): string {
  const names = commands ? Object.keys(commands).sort() : [];
  const available = names.length > 0
    ? names.map((n) => `/${n}`).join(', ')
    : '(none configured)';
  return (
    `Unknown slash command "/${name}". ` +
    `Available commands: ${available}.`
  );
}


/**
 * Look up a parsed command name in a slashCommands map, consulting OWN
 * properties only (agent-do-0qa). A plain `{}` map still has
 * Object.prototype on its lookup chain, so a bare bracket read turns
 * `/toString`, `/valueOf`, `/constructor`, `/hasOwnProperty`, … into
 * inherited methods and the dispatcher then crashes calling `.run()` /
 * `.stream()` on them. Own-property-only lookup makes those names take
 * the unknown-command path — while a command deliberately configured
 * under such a name (an own property) keeps dispatching.
 */
export function lookupSlashCommand(
  commands: Record<string, Agent> | undefined,
  name: string,
): Agent | undefined {
  if (!commands) return undefined;
  if (!Object.prototype.hasOwnProperty.call(commands, name)) return undefined;
  return commands[name];
}


// Split out of src/loop.ts (agent-do-4os).
/**
 * Deterministic slash-command dispatch for the non-streaming loop
 * (#76). Runs before any model call and before MCP mount, so routing
 * costs zero LLM tokens and never spins up the parent's servers.
 *
 * Returns a complete {@link RunResult} when the task is a slash
 * command (whether the command exists or not), or `null` to let the
 * normal loop take over.
 *
 * Usage accounting (agent-do-5oz): the sub-agent runs via
 * `runWithResult`, so its REAL usage — tokens, cost, records — is the
 * usage returned here, not zeros. Enforcement is the caller's job:
 * `runAgentLoop` records the dispatch's spend into the parent's tracker
 * and runs the parent's own `checkLimits()` on it (agent-do-tpp), so a
 * parent's `usage.limits` bounds routing too. Only a duck-typed sub without
 * `runWithResult` (possible when `runAgentLoop` is called directly
 * with a hand-built config that skipped `createAgent` validation)
 * falls back to the legacy zeroed shape.
 */
export async function tryRouteSlashCommandRun(
  config: AgentConfig,
  task: string,
  context?: string,
): Promise<RunResult | null> {
  if (!config.slashCommands) return null;
  const parsed = parseSlashCommand(task);
  if (!parsed) return null;

  const sub = lookupSlashCommand(config.slashCommands, parsed.name);
  if (sub) {
    // History is deliberately not forwarded (see AgentConfig.slashCommands
    // docs) — the sub-agent starts a fresh turn with the remainder.
    if (typeof sub.runWithResult === 'function') {
      const result = await sub.runWithResult(parsed.rest, context);
      // One parent-level dispatch hop; the sub's own steps live in
      // result.usage.steps. Propagate `aborted` so a sub aborted by
      // its own spending cap doesn't report a clean run.
      return {
        text: result.text,
        usage: result.usage,
        steps: 1,
        aborted: result.aborted,
      };
    }
    // Legacy fallback: no usage telemetry available from this sub.
    const text = await sub.run(parsed.rest, context);
    return {
      text,
      usage: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
        steps: 1,
        records: [],
      },
      steps: 1,
      aborted: false,
    };
  }

  // Unknown command — surface the listing as the final text. No model
  // call, so steps is 0.
  return {
    text: unknownSlashCommandMessage(parsed.name, config.slashCommands),
    usage: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      steps: 0,
      records: [],
    },
    steps: 0,
    aborted: false,
  };
}
