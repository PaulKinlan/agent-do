---
name: daily-task-prep
description: Prepare {{owner}}'s day — triage overnight inbox, check today's calendar, surface the top 3 priorities
version: 0.1.0
inputs:
  - name: date
    description: ISO date for the prep (YYYY-MM-DD). Defaults to today.
    optional: true
---

Run the standard morning prep for {{owner}}, scoped to {{date}} (or today if
omitted).

1. **Triage** the overnight signals in `inbox.md` by applying the
   priority-triage skill. Keep the decisions in-file; produce a rollup at the
   top of `inbox.md` under a `## Overnight` heading.
2. **Calendar sweep** — list today's meetings from `calendar.md` (or the
   calendar MCP server if mounted). For every meeting flag whether prep work
   is outstanding (does `tasks.md` have an open `[ ] prep for <meeting>` item?
   does the meeting have notes linked?).
3. **Top 3** — choose the three highest-priority items across inbox + tasks +
   calendar. Use priority-map. Write them to the top of `tasks.md` under
   `## Today`. Bump yesterday's un-done items below.
4. **Report** — summarise in <10 bullets what {{owner}} should look at first
   when they start their day.

Do not send anything. Every action item stays in a draft state until
{{owner}} signs off.
