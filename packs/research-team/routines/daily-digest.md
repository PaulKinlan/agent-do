---
name: daily-digest
description: Run the full scout → analyst → synthesiser → fact-checker pipeline for today's digest on {{topic}}
version: 0.1.0
inputs:
  - name: date
    description: ISO date for the digest (YYYY-MM-DD). Defaults to today.
    optional: true
---

Produce today's digest on {{topic}} for {{date}}.

1. **Scout** — apply the Scout Brief skill to produce `briefs/{{date}}.md`
   with 3–5 candidate sources from the last 24 hours.
2. **Analyse** — extract the signal from the scout brief. Note which claims
   are factual (must pass fact-check) vs interpretive.
3. **Synthesise** — apply the Synthesis Rubric skill to compose
   `digests/{{date}}.md`. Mark as `[DRAFT — pending fact-check]`.
4. **Fact-check** — apply the Fact Check skill. Output a fact-check report
   at `digests/{{date}}.fact-check.md`.
5. **Publish or rework** — if the fact-check recommends publishing, remove
   the draft marker. Otherwise loop back to step 3 with the corrections.

Hand back the final published digest. Never publish a digest with
unresolved WRONG / UNSUPPORTED items.
