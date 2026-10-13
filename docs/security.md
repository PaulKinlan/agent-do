# Security model

What the workspace tools guarantee, and what they do not. `docs/sandbox.md` covers the connector mechanics; this
document is about the boundary an operator is relying on.

## Two layers, and one surface that ignores both

`FilesystemMemoryStore`'s `readOnly` / `onBeforeWrite` hooks and the workspace **deny list** (`.env`, `*.pem`,
`.ssh/**`, `.git/**`, and anything from `--exclude`) are **policy**: they decide which operations the workspace
**file tools** will perform. The **sandbox connector** is the boundary: it decides what the agent can reach at all
when stores and the shell run through it.

Policy is what the model is allowed to *ask for* through the file tools; isolation is what it can *reach*. A defect
in policy is a bug with a fix; a defect in the boundary is a compromise.

**The shell tool is not covered by the deny list.** `createShellTool` runs whatever command it is given in the
sandbox, and the guard above the file tools is not in that path. Measured on a workspace containing `.env`:

```text
read_file('.env')   ->  Blocked by deny list: .env
bash: cat .env      ->  SECRET=...
```

So the deny list protects the **file-tool surface** — which matters, because that is the surface an agent has by
default — and not the agent's reach. If you grant shell execution, treat every file in the workspace as readable by
the model, deny list or not, and do not rely on the rules to hide anything from it.

## The deny list is a path policy, and a path cannot answer every question

Rules match **path patterns**. The resolver names the file a supplied path leads to, and the policy then asks
whether that resolved path matches. That resolution is single-implementation and tested against references - but it
can only answer *"which path does this name lead to"*. Some questions about file identity are not answerable from a
path at all:

- **Hard links are not covered.** A hard link is a second directory entry for the same inode. Given
  `fs.link('.env', 'notes/readme.txt')`, reading `notes/readme.txt` returns the contents of `.env`: it is not a link
  to follow, so there is nothing for resolution to canonicalise, and `notes/readme.txt` matches no rule. A
  **symlink** to the same file *is* blocked, because resolution names the target.
- **Reachability depends on what you grant.** The file tools cannot create a hard link: `write_file` writes a new
  inode, atomically via a temp file and rename, so it replaces rather than links. `createShellTool` runs in the same
  sandbox, so an agent given both the shell and the workspace tools can run `ln .env notes/readme.txt` and then read
  it through the file tools. Treat shell access as the ability to change what the path policy sees.

## What to do about it

A file **inside the workspace** cannot be kept from a model that has shell execution in that workspace. That is not
a defect to be fixed; it is what shell execution in a directory means, and the honest guidance follows from it:

- Keep secrets out of the workspace, or use `--no-tools` for a directory that contains them — the README's own
  advice. The deny list is not a substitute for this, and no path rule can be.
- Do not grant the shell tool unless you accept the workspace's contents as readable by the model.
- Use an isolating substrate (a container connector, or just-bash) to bound what the agent can reach **beyond** the
  workspace: the host filesystem, the network, other tenants. Isolation protects host data that is not mounted or
  seeded into the workspace. It does not make the workspace's own contents confidential from a shell running inside
  it.
- Do not treat `--include-sensitive` as a safety valve: it deliberately allows paths that resolve outside the
  workspace, and exists for operators who have decided the boundary is elsewhere.
- A connector that can *see* a symlink but cannot read it is refused rather than permitted, so a substrate with
  partial symlink support fails closed; the resolution rules are in `docs/sandbox.md`.
