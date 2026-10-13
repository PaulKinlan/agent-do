---
'agent-do': patch
---

Security fix: the workspace deny list (`.env`, `*.pem`, `.ssh/**`, `.git/**`, …) is evaluated on a canonicalised
path rather than the string the model supplied. Previously a legal `foo/../.env` and an in-workspace symlink to a
denied file both skipped the policy and returned the file's contents, and the same shapes bypassed the write deny
list — including writes to `.git/hooks/**`. A path that is lexically inside the workspace but resolves outside it
through a symlink is now blocked outright with the rule `outside-workspace`.

On a sandbox-backed workspace the canonicalisation runs through the workspace's substrate (`sandbox.realpath`) rather than the host filesystem, which has no entry for a virtual root; a connector without the optional `realpath` capability falls back to the lexical policy, which `docs/sandbox.md` names as the limitation it is.
A fresh write is resolved through its deepest existing ancestor, so a not-yet-existing leaf behind a symlinked directory (`.git/hooks/new-test`) is judged as the file it would land on; the policy and the store's containment check share one resolver so they cannot drift apart.
The deny list and the store's containment check now share a single resolver, and it follows a **dangling** symlink through the substrate's `stat`/`readlink` before any rule is evaluated - so a link whose target does not exist yet (`alias -> .git/hooks/planted`) is judged as its target rather than by the innocent alias, and a fresh write through it can no longer plant a git hook. `SandboxApi` gains an optional `readlink` capability for this.
