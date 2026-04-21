---
name: Scout Brief
description: Produce a structured scouting brief on a topic with 3–5 candidate sources
author: agent-do
version: 0.1.0
triggers:
  - scout this topic
  - find sources on
  - gather research on
  - what's new in
---

# Scout Brief

Produce a one-page brief on {{topic}} that the analyst can feed into
synthesis. **Do not synthesise yet** — the scout's job is recall, not opinion.

## Output format

```
# Scout Brief — {{topic}}

## Time window
<e.g. last 7 days>

## Candidate sources (3–5)
1. **<title>** — <outlet / author> — <date>
   URL: <canonical URL>
   Relevance: one sentence on why this matters.
2. ...

## Signals to flag for the analyst
- <short bullet for each recurring theme or surprising claim>

## Gaps
- <what you looked for but couldn't find>
```

## Rules

- 3–5 sources, no more. Force prioritisation.
- URLs must be canonical (no tracking parameters).
- Quote exact claim text in the "Signals" section when a source says
  something that will drive synthesis — the fact-checker will need it.
- If you have fewer than 3 sources, report that in "Gaps" rather than
  padding with weak sources.
