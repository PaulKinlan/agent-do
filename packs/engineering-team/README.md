# Engineering Team pack

A sprint-ordered engineering pipeline: **Think → Plan → Build → Review →
Ship → Reflect**. Each phase pairs a plan-time twin with an audit-time twin
that scores the output against the original plan.

This pack ships an initial set of reusable skills (`plan-review`,
`ship-checklist`, `retro`). Build out the role-specific twins (office hours,
CEO review, design review, QA, CSO, canary) by adding more skills under
`skills/` — the composition pattern is documented in the issue tracker.

## Install

```
npx agent-do install engineering-team
```

## Use

```ts
import { createTemplatePack } from 'agent-do';
import { createAnthropic } from '@ai-sdk/anthropic';

const { agent } = await createTemplatePack('engineering-team', {
  model: createAnthropic()('claude-sonnet-4-6'),
  variables: { team: 'platform' },
  workingDir: './repo',
});

const review = await agent.run(
  'Review plan.md against the CEO / engineering / design rubrics and flag anything blocking Build.',
);
```

## Customising

After install, edit the files under `.agent-do/packs/engineering-team/` to
fit your process. Add team-specific review rubrics, local ship checklist
items (e.g. "SOC-2 approval", "data-migration signoff"), and retro templates.
