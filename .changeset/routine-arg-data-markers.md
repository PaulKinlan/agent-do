---
'agent-do': minor
---

`run_routine` now renders model-supplied arguments inside a `<routine_arg name="…">` data marker and disarms
them: `</routine_arg>` / `</routine>` delimiters inside an argument value are neutralised, and
prompt-injection openers (`ignore previous instructions`, `--- system`, `<system>` …) are replaced with
`[redacted prompt-injection marker]`. The routine body is still operator instructions to follow, but the text
you pass as arguments is now marked as argument data rather than being laundered into the directive, so an
argument can no longer close the `<routine>` container early or plant a system-style override inside it.
`interpolateRoutine` gained an optional per-value formatter for this; its default behaviour and exported
signature (beyond the new optional argument) are unchanged.
