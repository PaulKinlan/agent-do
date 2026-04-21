/**
 * Example: Template Packs (#78)
 *
 * Compose a ready-to-run agent from a bundled pack. Packs bundle
 * skills + routines + policy modules + tool groups + MCP bindings
 * into a single install.
 *
 * Run:
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   npx tsx examples/16-template-packs.ts
 *
 * See also:
 *   - `npx agent-do list-packs` — shows bundled and installed packs
 *   - `npx agent-do install <pack>` — copies a pack into
 *     `.agent-do/packs/` so you can customise it in place.
 *   - `npx agent-do uninstall <pack>` — removes a user-installed copy.
 */

import { createTemplatePack } from 'agent-do';
import { createAnthropic } from '@ai-sdk/anthropic';

const { agent, manifest, systemPrompt, skills, routines } = await createTemplatePack(
  'chief-of-staff',
  {
    model: createAnthropic()('claude-sonnet-4-6'),
    variables: {
      owner: 'Ada Lovelace',
      timezone: 'Europe/London',
    },
    workingDir: './workspace',
  },
);

console.log(`Pack: ${manifest.name} v${manifest.version}`);
console.log(`Description: ${manifest.description}`);
console.log(`System prompt (${systemPrompt.length} bytes):`);
console.log(systemPrompt.slice(0, 400) + (systemPrompt.length > 400 ? '…' : ''));
console.log();
console.log(`Installed skills: ${skills.map((s) => s.id).join(', ')}`);
console.log(`Installed routines: ${routines.map((r) => r.id).join(', ')}`);
console.log();

const report = await agent.run(
  'Imagine the standard morning pass. Walk through what you would do step-by-step, citing the priority-map and auto-resolver policies.',
);

console.log('--- Agent report ---');
console.log(report);
