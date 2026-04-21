---
name: Retrospective
description: Structured post-mortem / retrospective on a completed piece of work
author: agent-do
version: 0.1.0
triggers:
  - retro
  - retrospective
  - post-mortem
  - what went wrong
  - what did we learn
---

# Retrospective

For a completed sprint, feature, or incident. Keep it short and specific.

## What we set out to do

One paragraph. State the original goal and the success criteria.

## What actually happened

- Timeline of key events with dates.
- What shipped, what didn't.

## What went well

- Bullet list. Be specific — `cache invalidation worked first time` not
  `things went smoothly`.

## What went wrong

- Bullet list. Focus on systems and process, not individuals. Each bullet
  should name the underlying cause, not the symptom.

## Action items

- [ ] <owner>: <action> by <date>

Keep action items to a maximum of five. More than five means nothing will
happen — prioritise.
