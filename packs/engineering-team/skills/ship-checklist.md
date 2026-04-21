---
name: Ship Checklist
description: Pre-flight checks before merging / deploying a change
author: agent-do
version: 0.1.0
triggers:
  - ready to ship
  - pre-deploy check
  - pre-merge checklist
  - ship checklist
---

# Ship Checklist

Run through every item. Any unchecked item blocks the ship.

- [ ] Tests pass locally and in CI.
- [ ] Lint / typecheck clean.
- [ ] Changelog / changeset entry added (user-facing prose, not "refactored
      loop.ts").
- [ ] Feature flag wired up OR rollback path documented in the PR body.
- [ ] Monitoring / alerting updated for any new failure mode.
- [ ] Docs updated for any API surface change.
- [ ] A canary / staged rollout plan exists if the blast radius is large.

Output the checklist with each box either checked or marked `FAIL: <why>`.
Never mark a box checked you haven't actually verified.
