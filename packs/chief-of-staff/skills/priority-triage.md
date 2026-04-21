---
name: Priority Triage
description: Classify an inbox item into P0/P1/P2/P3 and choose auto-resolve / draft-and-ask / escalate / ignore per the auto-resolver policy
author: agent-do
version: 0.1.0
triggers:
  - triage the inbox
  - process my inbox
  - classify this email
  - what's urgent today
---

# Priority Triage

Apply this skill every time a new signal enters `inbox.md` — whether it's an
email, a Slack DM pasted in, or a calendar invite.

## Steps

1. **Read the two policy files first:** `priority-map.md` and `auto-resolver.md`.
   These override anything in your memory. If the map promotes or demotes a
   sender since the last time you saw them, apply the new rule.
2. **Classify priority (P0–P3)** using the levels from priority-map. When two
   levels could apply, take the higher one.
3. **Choose a resolution mode** from auto-resolver:
   auto-resolve / draft-and-ask / escalate / ignore.
4. **Write the decision** into `inbox.md` next to the item, in the form:
   `[P1 | draft-and-ask] reason`.
5. **Produce a report** with three sections:
   - **Escalate now** — P0s and anything else that needs the principal today.
   - **Draft reply (needs approval)** — drafts written but not sent.
   - **Auto-resolved** — the ones you already handled.

## Never

- Never send a reply directly. Drafts go to {{owner}} for approval.
- Never skip reading the policy files, even on your tenth run of the day.
- Never classify from the sender alone — the message body may elevate
  priority (e.g. a P3 vendor sending a P0 security disclosure).
