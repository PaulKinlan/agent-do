---
'agent-do': patch
---

The fast gate runs the affected suites in a single vitest invocation instead of one process per suite, so its
start-up cost stops scaling with how many suites a change maps to. Measured on this fleet: a change to the hub
module `src/tools/types.ts` selected 37 of the repo's 50 suites and took 54 s as 37 node/vite start-ups - slower
than the full gate, which starts one process for all of them. Test files are still the unit of parallelism; only
the per-process start-up is gone.

Per-file results are mapped back from the runner's JSON report onto the suites the map selected, and a suite the
report does not name is reported **failed** rather than assumed to have run. A report covering only part of the
selection - a crashed, truncated or killed run - must never read as green.
