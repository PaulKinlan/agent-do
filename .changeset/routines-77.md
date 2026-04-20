---
"agent-do": minor
---

Saved Routines: prompt-as-macro primitive (closes #77).

A routine is a named, reusable procedure — "like a bash script but it's a prompt." Routines are distinct from skills:

| | Skill | Routine |
|---|---|---|
| Purpose | Instructions on when/how to do X | Named saved procedure |
| Triggering | Autonomous, description-matched | **Explicit by name**, optionally with args |
| Grows over time? | Hand-written | **Accumulates** — runCount + lastRun tracked |

### New exports

- `AgentConfig.routines` — any `RoutineStore`
- `AgentConfig.allowRoutineSave` — privileged flag to expose the `save_routine` tool (default false, same threat model as `allowSkillInstall`)
- `InMemoryRoutineStore`, `FilesystemRoutineStore`
- `parseRoutineMd(content, id?)` — markdown + YAML frontmatter parser
- `interpolateRoutine(body, args)` — `{{name}}` placeholder substitution
- `createRoutineTools(store, { allowSave })` — produces the tool set below
- Types: `Routine`, `RoutineStore`, `RoutineInput`

### Tools exposed to the model

Always:
- `list_routines` — id / name / description / runCount per routine
- `run_routine(routineId, args?)` — retrieve a routine, interpolate `{{arg}}` placeholders, return the body wrapped in `<routine>` markers for the model to follow. Bumps runCount + lastRun.

Gated behind `allowRoutineSave: true`:
- `save_routine` — persist a new routine. Same validation surface as `install_skill`.

### Storage

`FilesystemRoutineStore` stores each routine as `<rootDir>/<id>.md` with YAML frontmatter + body. Run metadata (runCount, lastRun) lives in a single `.runs.json` sidecar so routine files don't get rewritten on every invocation.

### Body interpolation

Bodies may contain `{{name}}` placeholders that get filled from the `args` object passed to `run_routine`. Unknown placeholders are left in place — the model can see which args it still needs.

Deliberately minimal: no conditionals, loops, or expressions. Routines are prompts, not DSLs.

### Example

See `examples/15-routines.ts` — pre-saves two routines (`triage-inbox`, `weekly-report`), then the agent runs one with an argument. `runCount` persists across runs.
