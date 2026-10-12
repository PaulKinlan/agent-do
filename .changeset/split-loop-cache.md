---
'agent-do': patch
---

Internal refactor: the Anthropic prompt-cache helpers (`isAnthropicModel`, the private `isAnthropicIdString`
and the cache-control breakpoint helper) moved out of `src/loop.ts` into `src/cache.ts`, the first step of
splitting that file by responsibility. `isAnthropicModel` is still re-exported from the loop module so
existing importers are unaffected, and no behaviour changed — the moved functions are byte-identical apart
from the `export` the cache helper now needs.
