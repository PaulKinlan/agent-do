---
name: nightly-backup
description: Snapshot the chief-of-staff workspace into backups/YYYY-MM-DD/ and archive resolved items
version: 0.1.0
inputs:
  - name: date
    description: ISO date for the backup folder (YYYY-MM-DD). Defaults to today.
    optional: true
---

Nightly maintenance — run once at end of day.

1. Make a `backups/{{date}}/` directory.
2. Copy `inbox.md`, `tracker.md`, `tasks.md` into it verbatim.
3. In `inbox.md`: move every entry tagged `[auto-resolved]` or `[ignore]` to
   an `## Archive` section at the bottom.
4. In `tasks.md`: move every checked-off task to a `## Completed — {{date}}`
   section at the bottom.
5. In `tracker.md`: verify that every row's `Next touch` date is still in the
   future; if it's past, bump the row's touch counter (see the
   follow-up-cadence skill) or move to `## Closed`.
6. Report the counts: how many archived / completed / moved to closed.

Do not contact anyone during backup. This is maintenance only.
