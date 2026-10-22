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

## Caller-registered tools: guarded by the loop, not by the tool

A tool you register yourself is a tool whose output **you** fetched: a web scraper, an HTTP call, a database query
returning third-party rows. Those results used to reach the model as a bare string — no boundary marker, no
injection-marker redaction, no size cap — while every built-in path (file, memory, workspace, shell, MCP,
provider-native, `delegate_task`) was framed and capped. That was a hole in the boundary, not a difference in trust
(`agent-do-3qb`).

The loop now normalises every tool's return value into a `ToolResult` and, when a tool returns anything that is not
already a `ToolResult`, puts it through the same guards: framed in `<tool_output tool="…" source="tool-return">`,
injection markers replaced with `[redacted prompt-injection marker]`, forged `</tool_output>` tags escaped so content
cannot close its own frame, and capped at 256 KB (`guardToolReturn` in `tools-build.ts`, applied by the per-call
execute wrapper).

What that does and does not buy you:

- **It is the same cost-raiser the built-in tools get, not a solution.** Redaction catches the obvious openers; a
  hostile page phrased as ordinary results still reads as ordinary results.
- **A tool that returns a `ToolResult` is trusted to have done its own guarding** and is passed through untouched.
  That is deliberate: it is how the built-in tools avoid being framed twice, and it is the escape hatch for a tool
  whose output is structured and cannot carry a text frame. If such a tool renders third-party text into
  `modelContent` without calling `wrapForModel` / `sanitiseUntrustedText`, it has opted out of the boundary.
- **`userSummary` is not framed.** The operator view keeps the tool's raw text on purpose — logs need the
  diagnostics, and an operator reading an injection attempt is how it gets reported.

## Provider-native tools: guarded as far as the provider protocol allows

Provider packages ship **provider-executed** tools — Google `googleSearch` / `urlContext`, Anthropic `webSearch_*` /
`webFetch_*`, OpenAI `webSearch` — whose results the provider produces server-side. `--provider-tool` enables them
from the CLI, and a script export can register them under any tool key. Their results carry arbitrary third-party
web content into the model's context, so they are not exempt from the guards the file, memory, shell, MCP and
orchestrator tools apply (`tools/content-guards.ts`); they go through them via `tools/provider-output-guard.ts`,
installed by `buildTools` on any tool that reports `type: 'provider'` with `isProviderExecuted: true`.

What the guard guarantees, and why it is not simply `wrapForModel`:

- **A text result is framed exactly like any other tool result** — `<tool_output tool="…" source="provider-native">`
  boundary, injection markers redacted, byte cap applied.
- **A structured (JSON) result is redacted in place.** Every string leaf gets the same treatment (boundary tags
  escaped, injection markers replaced) while keys, value types and structure are preserved, so the payload still
  satisfies the provider's own `outputSchema`. It is **not** framed and **not** truncated: the provider converts the
  payload back into its wire format on the next request, and a payload rewritten into a `<tool_output>` string (or a
  capped `encryptedContent`, or a half-base64 document) is dropped or rejected there — which breaks the
  `tool_use` / `tool_result` pairing and fails the whole conversation instead of protecting it. Redaction is the part
  that carries no such cost.

So the boundary is honest about its edges:

- **Content the provider synthesises into its answer is not framed here.** Grounded answers and citations come back
  as the assistant's own text parts, not as tool results, so no guard in this process sees them. Treat a grounded
  answer as web content: the model may quote it and should not obey it.
- **The guard is a cost-raiser, not a solution.** Redaction catches the obvious injection openers and escapes forged
  boundary tags; it cannot recognise a hostile page phrased to look like ordinary results. A tool that fetches
  arbitrary URLs is a trust decision, not a toggle: leave `--provider-tool` off when the agent's own instructions are
  the thing worth protecting.
