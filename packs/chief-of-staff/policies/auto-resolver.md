# Auto-resolver

How the chief of staff decides to act on each signal. Four modes:

- **auto-resolve:** act without asking. OK for P2/P3 informational replies,
  out-of-office confirmations, calendar confirmations matching a standing
  preference, and meeting reschedules that don't break a commitment.
- **draft-and-ask:** write the reply / action but wait for {{owner}}'s
  approval. Default for P1 customer replies, new commitments, anything
  touching money, and any first-time outreach to a new contact.
- **escalate:** surface directly to {{owner}}, do not draft. P0 items,
  conflicts in priority-map, legal/compliance signals, security incidents.
- **ignore:** filter spam, confirmed duplicates, no-reply newsletters,
  cold pitches that don't match {{owner}}'s interests.

## Source-of-truth rule

Never auto-resolve from memory alone. Always re-read the current state of
`inbox.md`, `tracker.md`, and `tasks.md` before acting. If a file disagrees
with what you remember, trust the file.

## Hand-off contract

When delegating to a specialist, include in the hand-off:

1. The raw signal (email body / event / task).
2. Your priority classification + resolution mode.
3. Which file(s) the specialist should read before responding.
4. A one-line summary of why this matters to {{owner}}.
