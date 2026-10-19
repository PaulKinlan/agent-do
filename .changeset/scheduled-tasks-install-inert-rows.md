---
'agent-do': minor
---

`agent-do scheduled-tasks install` now emits inert, safely escaped crontab rows. A task description containing
a newline could forge a second, standalone crontab entry that system cron executed on schedule — descriptions
are collapsed to one line (control characters shown as `?`) and `%` is cron-escaped. The tasks-file and
memory-dir paths are POSIX single-quoted, so `$(`, backticks, `"` or a newline in a path can no longer execute
in (or add rows to) the fired job.
