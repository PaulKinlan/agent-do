---
'agent-do': patch
---

The default write deny list now covers `.github/actions/**` (any depth). Composite actions defined there execute inside CI workflows — a workflow referring to `uses: ./.github/actions/build` runs whatever `runs.steps[].run` says, so writing one was a way to change what CI executes despite the workflow files themselves being denied. Reads stay allowed, and `--include-sensitive` remains the explicit opt-out (agent-do-16de).
