# Engineering Team demo

Sprint-ordered pipeline for planning a feature ([inspired by garrytan/gstack](https://github.com/garrytan/gstack)). Master runs 5 phases in order, each handed off to a specialist that produces a written artifact the next phase consumes.

## The pipeline

```
Think   → office-hours        → 01-design-doc.md     (6 forcing questions)
Plan    → plan-eng-review     → 02-plan.md           (ASCII diagrams, edge cases, test matrix)
Review  → investigate         → 03-investigation.md  (existing code paths, invariants, risks)
Test    → qa                  → 04-test-plan.md      (red-team the plan, acceptance criteria)
Ship    → release-engineer    → 05-rollout.md        (stages, metrics, rollback)
```

## What it shows

- **Sprint-ordered pipeline** — each phase strictly follows the previous; specialists consume the prior phase's artifact as input.
- **Specialist role prompts** — opinionated stances baked into each system prompt (QA's "lean pessimistic", Investigator's "Iron Law: no fixes without investigation", Release Engineer's "3 AM rollback test").
- **Forcing questions as scaffolding** — office-hours doesn't design; it interrogates. The 6-question template is the forcing function.
- **Shared workspace** — every artifact lives in `./sprint/` so phases can reference each other explicitly.

## Setup

```sh
export ANTHROPIC_API_KEY=sk-ant-...
npm install
npm start "Add an audit log for write operations"
# Or run interactively:
npm start
```

## Structure

```
index.ts        — master + 5 phase workers, wired to one FilesystemMemoryStore
sprint/         — created on first run
  01-design-doc.md      (from office-hours)
  02-plan.md            (from plan-eng-review)
  03-investigation.md   (from investigate)
  04-test-plan.md       (from qa)
  05-rollout.md         (from release-engineer)
```

## Role-pair idea (not implemented here)

gstack uses a role-pair pattern: plan-time twins (`plan-design-review`, `plan-devex-review`, `plan-eng-review`) paired with audit-time twins (`design-review`, `devex-review`, `review`) that score the built result against what the plan predicted. This demo only runs the plan-time phases. The audit pair would run after implementation and would be a natural extension once the engineering-team pack abstracts this pipeline (#78).
