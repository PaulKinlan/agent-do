---
'agent-do': patch
---

Security: `Agent.run(task, context)` no longer pastes caller-supplied context into the system message verbatim. Context now arrives in the `<tool_output>` data frame the prompt already teaches the model to treat as untrusted data: boundary tags in the text are escaped so it cannot close the frame early, injection-shaped markers are replaced by a visible `[redacted prompt-injection marker]`, a sentence says the block is data rather than instructions, and the size is capped at the standard read cap (an oversized context is truncated instead of pasted). Ordinary context is otherwise delivered unchanged.
