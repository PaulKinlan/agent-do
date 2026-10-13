---
'agent-do': patch
---

Security fix: the workspace deny list (`.env`, `*.pem`, `.ssh/**`, `.git/**`, …) is evaluated on a canonicalised
path rather than the string the model supplied. Previously a legal `foo/../.env` and an in-workspace symlink to a
denied file both skipped the policy and returned the file's contents, and the same shapes bypassed the write deny
list — including writes to `.git/hooks/**`. A path that is lexically inside the workspace but resolves outside it
through a symlink is now blocked outright with the rule `outside-workspace`.

On a sandbox-backed workspace the canonicalisation runs through the workspace's substrate (`sandbox.realpath`) rather than the host filesystem, which has no entry for a virtual root. A connector's optional capabilities do not decide *whether* a path is resolved - the walk runs either way, because `stat` can report a symlink on its own. A connector that reports **no symlinks** keeps the lexically normalised path, and one that can *see* a symlink but cannot read its target is refused rather than judged by the link's own name.
A fresh write is resolved through its deepest existing ancestor, so a not-yet-existing leaf behind a symlinked directory (`.git/hooks/new-test`) is judged as the file it would land on; the policy and the store's containment check share one resolver so they cannot drift apart.
The deny list and the store's containment check now share a single resolver, and it follows a **dangling** symlink through the substrate's `stat`/`readlink` before any rule is evaluated - so a link whose target does not exist yet (`alias -> .git/hooks/planted`) is judged as its target rather than by the innocent alias, and a fresh write through it can no longer plant a git hook. `SandboxApi` gains an optional `readlink` capability for this.

Documented one boundary of this path-based policy, and corrected the deny-list section's description of a connector that can see symlinks without the primitives to read them (the resolver walks either way and refuses an identified link it cannot read). A **hard link** is a second directory entry for the same inode, so a deny-listed file reached under a non-denied name is not matched by path rules - `docs/security.md` states the boundary and the operator guidance (use an isolating substrate, or do not grant shell execution that can create hard links).

Also documented the boundary the deny list does NOT cover: it governs the workspace **file tools**, but a shell tool (`createShellTool`) runs the command it is given without consulting it, so `cat .env` returns what `read_file('.env')` blocks - measured, and stated in `docs/security.md` and the sandbox deny-list section. A hard link is a narrower version of the same point (a path policy cannot match a second name for the same inode). Guidance for secrets inside a workspace: keep them out of it or use `--no-tools`; isolation bounds what the agent reaches beyond the workspace, not its confidentiality from a shell inside it.
