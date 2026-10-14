---
'agent-do': patch
---

The gate's static step now runs `node tools/gen-suite-map.mjs --check` before the build, so a stale
`tools/suite-map.tsv` or `tests/coverage-contract.json` fails a lane's own fast gate instead of only the merger's
full gate. `tests/gates.test.ts` pins the command and its order.
