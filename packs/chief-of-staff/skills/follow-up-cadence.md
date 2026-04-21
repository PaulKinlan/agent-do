---
name: Follow-up Cadence
description: Standard BD follow-up schedule — when to nudge, when to drop a lead
author: agent-do
version: 0.1.0
triggers:
  - follow up with leads
  - nudge this prospect
  - when should we reach out
  - bd follow-up
---

# Follow-up Cadence

The standing cadence for outbound BD — read `tracker.md` first, never
nudge from memory.

## Schedule

| Touch | Delay since previous | Channel | Template tone |
|-------|---------------------|---------|---------------|
| 1 | Day 0 (initial contact) | Email | Warm intro, 3 sentences, one clear ask |
| 2 | +2 business days | Email reply | Short bump, reference the first message |
| 3 | +5 business days | Email reply | One-liner + alternative path (call / async) |
| 4 | +7 business days | Closing note | "I'll stop bumping — open to reconnect any time" |

## Stop conditions

- Stop after touch #4. Do not continue.
- Stop immediately if the lead says "not now" or "please remove me".
- Stop immediately if the lead replies — switch to the normal conversation.

## Tracker hygiene

After every touch:

1. Update the `Next touch` column in `tracker.md` to the scheduled date.
2. Increment the touch count in the `Status` column: `Touch 2 sent 2026-04-21`.
3. When you hit stop conditions, move the row to a `## Closed` section with
   the outcome recorded.
