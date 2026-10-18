---
'agent-do': patch
---

Guard for scheduled-task payloads: `loadTasks` is deliberately a bare `JSON.parse` and now says so, because `payload` is opaque user data (`z.record(z.string(), z.unknown())`) and a legitimate key named `constructor` or `prototype` inside it must survive. A prototype-pollution reviver at that site silently erased those fields before the payload was stringified for the agent (agent-do-upf). An own `__proto__` key is dropped by Zod's record rebuild rather than preserved; it is not applied to any prototype, and the loader's comment states that limit explicitly (agent-do-kux). Structural safety is unchanged: Zod rebuilds the array and task objects from declared fields only, so a `__proto__` at the task level is discarded, and nothing assigns parsed keys onto another object. Tests pin both halves.
