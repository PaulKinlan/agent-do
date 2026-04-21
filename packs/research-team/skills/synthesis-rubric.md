---
name: Synthesis Rubric
description: Rules for composing the daily digest from the analyst's extracted signals
author: agent-do
version: 0.1.0
triggers:
  - write the daily digest
  - synthesise the research
  - compose the digest
---

# Synthesis Rubric

Given an analyst report on {{topic}}, compose the daily digest.

## Structure

```
# {{topic}} — <Date>

## TL;DR
<3 sentences, maximum. The one thing a busy reader should know.>

## What happened
- 2–4 bullets of the most important developments. Each bullet names a source
  with a bracketed citation: `[Source 3]`.

## What to watch
- 1–2 forward-looking items: trends, upcoming events, open questions.
```

## Rules

- 500 words absolute max. If it doesn't fit, cut — don't abbreviate.
- Every factual claim must carry a citation pointing at an entry from the
  scout brief.
- No hedging — if the sources disagree, say so explicitly and attribute.
- No editorialising — the rubric is about selection, not opinion.
- Hand off to the fact-checker before publishing. Mark the digest
  `[DRAFT — pending fact-check]` until then.
