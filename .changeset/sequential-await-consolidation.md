---
'agent-do': patch
---

Two measured hot-path improvements, and two candidates deliberately left alone. `RoutineStore.list()` now reads routine files concurrently (300 routines: 110-122 ms before, 61-82 ms after, median 71 ms on this VM), and regex assertions reuse a compiled pattern instead of recompiling one per evaluation (a fresh `new RegExp(...).test()` costs 3.8x a reused compile+test over 200k evaluations). `/g` and `/y` patterns are deliberately not cached: they carry `lastIndex` between calls, so reuse would change their results. Parallelising the eval-suite and provider-SDK dynamic imports measured no gain (1.2x and 0.9x), because Node's ESM loading is CPU-bound module-graph work rather than overlappable I/O, so those were left serial.
