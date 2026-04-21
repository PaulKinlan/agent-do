---
name: Fact Check
description: Verify every factual claim in a digest against a cited source
author: agent-do
version: 0.1.0
triggers:
  - fact check this
  - verify the claims
  - check the sources
  - fact-check the digest
---

# Fact Check

Run this before publishing any digest. You are the last line before the
reader sees a wrong claim.

## For every bracketed citation

1. Open the source.
2. Verify that the claim in the digest matches what the source actually says.
3. If the claim is paraphrased — confirm the paraphrase preserves the
   original meaning, including any quantifiers ("most", "some", "all") and
   any dates.

## Flag

- **WRONG** — source contradicts the claim. Must be removed or corrected.
- **UNSUPPORTED** — source doesn't say what the digest claims. Must be
  removed or re-cited.
- **WEAK** — source says it but only implicitly / second-hand. Add a
  qualifier or find a stronger source.
- **OK** — claim matches source exactly.

## Output

For each citation, report `[Source N] CLAIM — STATUS`. Then give a
single recommendation: "Publish", "Publish with corrections (listed)", or
"Do not publish — rework needed".
