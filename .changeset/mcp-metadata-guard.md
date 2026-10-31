---
'agent-do': minor
---

MCP tool metadata is now guarded before it reaches the model. A mounted MCP server's tool descriptions and input schemas are instruction-channel content the model sees before any call happens; they previously arrived verbatim from the server. Descriptions are now framed with a provenance line naming the server, have injection markers redacted and forged boundary tags escaped, and are capped at 8 KB with an explicit truncation note. Input schemas get their `description` / `title` strings sanitised, and a schema over 32 KB (or nested past the walk's depth cap) is replaced with a permissive schema whose replacement is announced in the tool description. Validation-relevant schema fields (`enum`, `const`, `pattern`, property names) are untouched, so argument contracts are unchanged for honest servers.
