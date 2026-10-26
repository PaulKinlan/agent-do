---
'agent-do': patch
---

Slash-command dispatch no longer admits Object.prototype property names as commands: `/toString`, `/valueOf`, `/constructor`, `/hasOwnProperty` and `/__proto__` now return the unknown-command listing (with no model call) instead of crashing the run with an unhandled `TypeError`. Commands deliberately configured under those names keep working.
