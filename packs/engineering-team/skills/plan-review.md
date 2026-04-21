---
name: Plan Review
description: Score a proposed implementation plan against CEO, engineering, and design rubrics
author: agent-do
version: 0.1.0
triggers:
  - review this plan
  - plan review
  - score the proposal
  - what are the risks in this plan
---

# Plan Review

Apply this three-axis rubric before any build work starts.

## CEO axis (user / business outcome)

- Does the plan state the user-visible outcome in one sentence?
- Is the outcome the *simplest* one that unblocks the goal, or is it
  gold-plated? Call out scope creep explicitly.
- Are success metrics named and measurable?

## Engineering axis

- Does the plan identify the smallest unit that can ship safely?
- What's the rollback story? (Feature flag, migration, revert.)
- Where does it break backward compatibility, if anywhere?
- What tests prove the change works *and* prove the regression doesn't
  come back?

## Design / UX axis

- Is the user's first-run experience described step-by-step?
- Are the failure modes designed for (not just handled)?
- Does the change need copy review, accessibility check, or localisation?

## Output

A single numbered list of concerns, ordered most-blocking first. Each item
names the axis it came from. If the plan passes all three axes, say so
explicitly and recommend moving to Build.
