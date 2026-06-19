/**
 * Example 20: Policies — typed system-prompt modules (#80)
 *
 * Policies are markdown documents that inject into the system prompt in
 * a well-marked, escape-protected section. Unlike skills (which extend
 * capabilities and fire autonomously), policies are constraints /
 * context that ground every decision on every turn — a priority-map
 * (who/what matters) plus an auto-resolver (how to resolve) is the
 * canonical pair.
 *
 * This example uses createMockModel() so it runs without an API key.
 * The mock captures the system prompt the agent actually sent so we
 * can show the rendered `## Policies` section.
 *
 * Run: npx tsx examples/20-policies.ts
 */

import {
  createAgent,
  createPolicy,
  buildPoliciesPrompt,
  type Policy,
} from 'agent-do';
import { createMockModel } from 'agent-do/testing';

console.log('═══════════════════════════════════════');
console.log('  Example 20: Policies');
console.log('═══════════════════════════════════════\n');

// ── Define the canonical priority-map + auto-resolver pair ──
//
// `createPolicy` takes an object ({ id, type, content }) or a source
// string ({ id, type, source }) where source is a POLICY.md-style doc
// with YAML frontmatter. Here we use the object form for the priority
// map and the source form for the auto-resolver to show both.

const priorityMap = createPolicy({
  id: 'priority-map',
  type: 'prioritisation',
  content: `# Priority Map

## Levels
- **P0** — production down, data loss
- **P1** — customer-blocking, revenue-impacting
- **P2** — important but not urgent
- **P3** — nice to have

## Routing
- Security signal → escalate immediately
- Customer complaint → draft-and-ask`,
});

const autoResolver = createPolicy({
  id: 'auto-resolver',
  type: 'resolution',
  source: `---
id: auto-resolver
type: resolution
version: 1
---

# Auto-resolver

Pick a resolution mode per signal:
1. **auto-resolve** — safe, reversible, low-stakes
2. **draft-and-ask** — needs human judgement; draft the reply
3. **escalate** — high-stakes, irreversible, or political
4. **ignore** — noise / out of scope`,
});

console.log('Defined 2 policies:');
console.log(`  - ${priorityMap.id} (${priorityMap.type})`);
console.log(`  - ${autoResolver.id} (${autoResolver.type}, version ${autoResolver.version})\n`);

// ── Show the rendered system-prompt section ──
console.log('── Rendered `## Policies` section ──\n');
const section = buildPoliciesPrompt([priorityMap, autoResolver]);
console.log(section.trim());
console.log('\n── end section ─\n');

// ── Wire policies into an agent ──
//
// `AgentConfig.policies` is a plain array (operator-authored — there's
// no LLM install tool, since a model rewriting its own policy would be
// a persistent jailbreak). The loop injects the section above into the
// system prompt on every run. buildPoliciesPrompt already proved the
// rendering above; this run shows the agent wiring compiles and runs.
const model = createMockModel({
  responses: [{ text: 'Acknowledged — P0 means production down.' }],
});

const agent = createAgent({
  id: 'policy-agent',
  name: 'Policy Agent',
  model,
  systemPrompt: 'You are a triage assistant. Apply the installed policies to every decision.',
  policies: [priorityMap, autoResolver],
  maxIterations: 3,
});

const result = await agent.run('What does P0 mean?');
console.log('Agent output:');
console.log(`   ${result}\n`);

// ── InMemoryPolicyStore: round-trip for callers who want store semantics ──
//
// Policies are usually supplied directly as an array. A PolicyStore is
// available for callers who load policies from disk / config and want
// install/list/remove semantics (e.g. hot-reloading a policies/ dir).
const { InMemoryPolicyStore } = await import('agent-do');
const store = new InMemoryPolicyStore();
await store.install(priorityMap);
await store.install(autoResolver);
const loaded = await store.list();
console.log(`PolicyStore holds ${loaded.length} policies: ${loaded.map((p: Policy) => p.id).join(', ')}\n`);

console.log('Done — policies inject into the system prompt on every run.');
