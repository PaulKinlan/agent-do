---
'agent-do': minor
---

Mode `'ask'` no longer silently allows every tool call when no `onPermissionRequest` callback is supplied. A config with `mode: 'ask'` and no callback is now rejected when the agent is created, with an error naming the missing callback, and if such a config reaches the permission check anyway the call is denied rather than allowed.

This is a behaviour change for embedders who relied on the silent allow: that config read as "ask me first" and behaved as "allow everything" — a fail-open in the one mode that exists to be fail-closed. Supply `onPermissionRequest`, or use `mode: 'accept-all'`/`'deny-all'` to decide without asking. The README, api-reference and llms.txt described the old fallback and now state the requirement.
