---
'agent-do': patch
---

A relative symlink target is now joined against the **canonical** directory containing the link. On a sandbox
connector without a `realpath` primitive, a path that traversed an unresolved ancestor link could previously
resolve to an attested but wrong location when the target's own `..` cancelled that ancestor's name.
