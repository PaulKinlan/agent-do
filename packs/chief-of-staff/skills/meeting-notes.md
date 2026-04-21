---
name: Meeting Notes
description: Capture structured meeting notes and propagate action items into tasks.md
author: agent-do
version: 0.1.0
triggers:
  - take meeting notes
  - capture meeting outcomes
  - write up this meeting
  - post-meeting follow-up
---

# Meeting Notes

Capture every meeting in a consistent structure so {{owner}} can scan the
weekly rollup in one pass.

## Output file

Write the note to `meetings/YYYY-MM-DD-<slug>.md` where `slug` is the meeting
title kebab-cased.

## Required sections

```
# <Meeting Title> — <Date>

**Attendees:** ...
**Topic:** one line summary

## Decisions
- ...

## Action items
- [ ] <owner>: <action> (due <date>)

## Open threads
- ...

## Notes
Free-form context.
```

## After writing

- For every unchecked action item under `## Action items`, append a matching
  entry to `tasks.md` under the owner section — or under `## Principal` if the
  owner is {{owner}}. Include a back-link to the meeting file so the task
  carries its context.
- Flag any **decision** involving money, hiring, or a customer commitment for
  `draft-and-ask` review (per auto-resolver).
