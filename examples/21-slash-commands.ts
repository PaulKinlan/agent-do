/**
 * Example 21: Slash-command router
 *
 * Deterministic pre-model dispatch: when the user's input starts with
 * `/<name>`, the loop routes the remainder to a configured sub-agent
 * BEFORE any model call on the parent. Routing is structural — zero LLM
 * cost, zero tool round-trips. Contrast with the orchestrator, where
 * the *model* decides to delegate via `delegate_task`.
 *
 * This example uses createMockModel so it runs with no API key:
 *
 *   /research quantum cryptography  →  runs the `research` sub-agent
 *   /review                         →  runs the `review` sub-agent (empty args)
 *   /unknown                        →  returns a listing, no model called
 *   plain text                      →  parent handles it as normal
 *
 * Run: npx tsx examples/21-slash-commands.ts
 */

import { createAgent } from 'agent-do';
import { createMockModel } from 'agent-do/testing';

// Two sub-agents, each with its own mock model, tools, and system prompt.
// In a real app these would point at a real provider (createAnthropic()
// etc.) and carry their own tool sets.
const research = createAgent({
  id: 'research',
  name: 'Researcher',
  model: createMockModel({
    responses: [{ text: 'Researched: quantum cryptography uses qubits.' }],
  }),
  systemPrompt: 'You are a research specialist.',
});

const review = createAgent({
  id: 'review',
  name: 'Reviewer',
  model: createMockModel({
    responses: [{ text: 'Review: looks good, ship it.' }],
  }),
  systemPrompt: 'You review code for correctness and style.',
});

// The parent wires them under slash-command names. Keys must match
// /^[a-zA-Z0-9_-]+$/; nested slash commands (/a/b) are rejected at
// createAgent() time.
const parent = createAgent({
  id: 'parent',
  name: 'Parent',
  // The parent model only runs for non-slash input.
  model: createMockModel({ responses: [{ text: 'Parent handled this.' }] }),
  slashCommands: { research, review },
});

console.log('═══════════════════════════════════════');
console.log('  Example 21: Slash-command router');
console.log('═══════════════════════════════════════\n');

// 1. Valid dispatch — routes to `research` with the remainder.
const r1 = await parent.run('/research quantum cryptography');
console.log('/research quantum cryptography  →', r1);

// 2. Empty args — still dispatches (sub-agent receives '').
const r2 = await parent.run('/review');
console.log('/review                        →', r2);

// 3. Unknown command — deterministic listing, parent model never called.
const r3 = await parent.run('/ship');
console.log('/ship                          →', r3);

// 4. Non-slash input — parent handles it as normal.
const r4 = await parent.run('what is the weather?');
console.log('what is the weather?           →', r4);

console.log('\n(parent model is only invoked for case 4.)');
