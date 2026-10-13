# Security model

What the workspace tools guarantee, and what they do not. `docs/sandbox.md` covers the connector mechanics; this
document is about the boundary an operator is relying on.

## Two layers, only one of which is a boundary

`FilesystemMemoryStore`'s `readOnly` / `onBeforeWrite` hooks and the workspace **deny list** (`.env`, `*.pem`,
`.ssh/**`, `.git/**`, and anything from `--exclude`) are **policy**: they decide which operations the agent's tools
will perform. The **sandbox connector** is the boundary: when stores and the shell run through
`SandboxBackedMemoryStore` or an isolating connector, no path inside the agent reaches the host filesystem without
passing through it.

Policy is what the model is allowed to *ask for*; isolation is what it can *reach*. A defect in policy is a bug
with a fix; a defect in the boundary is a compromise.

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

- If you need **strict confidentiality of files inside the workspace**, do not rely on path policy for it. Use an
  isolating substrate (a container connector, or just-bash), so the inode is not reachable under another name inside
  the agent's view - or do not grant shell execution that can create hard links. Hard links cannot cross
  filesystems, so the substrate's own boundary is what actually holds here.
- Do not treat `--include-sensitive` as a safety valve: it deliberately allows paths that resolve outside the
  workspace, and exists for operators who have decided the boundary is elsewhere.
- A connector that can *see* a symlink but cannot read it is refused rather than permitted, so a substrate with
  partial symlink support fails closed; the resolution rules are in `docs/sandbox.md`.
