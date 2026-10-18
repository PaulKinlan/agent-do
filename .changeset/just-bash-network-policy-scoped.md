---
'agent-do': patch
---

Doc fix only: the just-bash connector no longer claims a network policy it cannot keep on both construction paths. The module header and `docs/sandbox.md` now state that only `createJustBashSandbox({ allowNet })` forwards a network policy (passing `false` when omitted, never leaving it unset), and that `wrapJustBashSandbox(instance)` inherits whatever the caller's instance was constructed with and can neither set nor attest it.
