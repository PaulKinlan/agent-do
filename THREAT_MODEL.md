# Threat model

agent-do runs an autonomous LLM agent with filesystem, memory, shell and network-adjacent tools attached, in the
operator's own process and under the operator's own user. This document states what an agent run can touch, which
inputs on those paths are attacker-controlled, which control stands in front of each, and which exposures the
project has decided to live with. It exists because those guarantees were previously only stated per control, in
`docs/security.md`, `docs/sandbox.md`, `docs/supply-chain.md` and in comments beside the code.

Citations are `path:line` against the tree at commit `a151c46`; `agent-do-<id>` names the bead that introduced or
last changed the control, so a reviewer can read the reasoning rather than re-derive it. Read the two-layer
distinction first (`docs/security.md:6-15`): the deny list and the store's `readOnly` / `onBeforeWrite` hooks are
**policy** — what the model may ask a tool for. The sandbox connector is the **boundary** — what the agent can reach
at all. A defect in policy is a bug with a fix; a defect in the boundary is a compromise.

## 1. Scope and assets

What a run holds, and what an attacker would want from it.

| Asset | Reached through | Persistence |
|---|---|---|
| Workspace files (contents and names) | `createWorkspaceTools(workingDir)` — read/write/delete/grep/find, rooted at `--cwd` (`src/tools/workspace-tools.ts:130-135`) | operator's project; may contain `.env`, keys, CI config |
| Memory store | `FilesystemMemoryStore` / `SandboxBackedMemoryStore`, one directory per `agentId` (`src/stores/filesystem.ts:68-95`) | survives the run; re-enters later prompts |
| Shell reach | `createShellTool` over a `SandboxApi` (`src/tools/shell-tool.ts`) | n/a — but writes land where the connector allows |
| Saved-agent configs | `.agent-do/agents/<name>.json`, found by walking **up** from cwd (`src/cli/agents.ts:129-150`) | file on disk; `systemPrompt` becomes the system tier |
| Trust store | `~/.agent-do/trusted-agents.json` (`src/cli/agent-trust.ts:90-95`) | user-scoped; the only record of "the operator sanctioned this content" |
| shellm frontmatter | `.shellm` file whose `system:` key replaces the system prompt (`src/cli/shellm.ts:41-50`) | file on disk |
| Scheduled-task status + locks | `scheduler-status.json` and `<memoryDir>/.locks` (`src/scheduled-tasks/fs.ts:140-158`) | shared across hosts mounting the same dir |
| Provider credentials | process environment (`src/cli/resolve-model.ts:44`) | process lifetime; also in `/proc/$PPID/environ` |
| Skill bodies | installed skills become system-prompt material (`src/skills.ts:109-128`) | store the caller supplies; `install_skill` is off by default (`src/skills.ts:502-516`) |
| The operator's terminal | permission prompts and streamed output (`src/cli/permission-handler.ts:114-120`, `src/cli/render.ts:26`) | n/a |
| The model context itself | every path above terminates here | the conversation, and anything written into it |

## 2. Trust boundaries

**B1 — model → tools (tool arguments).** Every tool argument is chosen by the model, so it is untrusted input to the
tool. Paths (`read_file`, `write_file`), `grep_file` patterns with `regex: true`, a shell `cwd` and a memory key all
cross here. The model is not an attacker, but a hostile page or file that reaches the model's context can choose its
next tool call.

**B2 — workspace → model (file contents and file names).** A cloned repository, a checked-out branch, an extracted
tarball or a shared directory supplies both. Contents are the classic prompt-injection carrier; names are a
line-format problem (`src/tools/content-guards.ts:158-165`).

**B3 — tool output → model (prompt-injection surface).** Everything a tool returns becomes model context: file
bodies, command output, MCP responses, provider-native web results, worker output from `delegate_task`. This is the
widest boundary in the system, because it gains a new crossing each time a tool is added.

**B4 — on-disk instructions → system tier.** A saved-agent config's `systemPrompt`, and a shellm file's `system:`
key, arrive from a file that may have shipped with a repository. This is the opposite of B3: the text is
*instructions*, not data (`docs/security.md:117-131`).

**B5 — shared directory → scheduler.** Status and lock files are JSON/plain files in a directory that may be shared
("the lock dir … is shared across hosts mounting the same dir", `src/scheduled-tasks/fs.ts:118-121`).

**B6 — process environment → shell.** A command spawned by the host connector runs as the same user in the same PID
namespace (`docs/sandbox.md:129-135`).

**B7 — model-chosen text → operator terminal.** The permission prompt is written by this process but composed from a
model-chosen tool name and argument preview (`src/cli/permission-handler.ts:94-120`).

**B8 — operator → the run (trusted).** CLI flags, `config.permissions`, hooks and library code are the operator's own
decisions. See §3.

## 3. TRUSTED vs UNTRUSTED

### Explicit non-threats

These are deliberate trust decisions; an audit should not report them as vulnerabilities.

- **The shipped code.** The loop, the tools and the CLI are the trusted computing base. A defect in them is a bug,
  not an attack surface.
- **The operator's own CLI flags and config.** `--accept-all`, `--script`, `--trust-agent-config`,
  `--include-sensitive`, `--exclude`, `--allow`, `--read-only`, `--no-tools` (`src/cli/args.ts:233-305`) are
  decisions made by the human invoking the tool. `SECURITY.md` puts "a user explicitly opting out of a control" out
  of scope; `--include-sensitive` "deliberately allows paths that resolve outside the workspace" (`docs/security.md:56`).
- **The deny-list defaults as shipped** (`src/tools/deny-list.ts:41-95`). A conservative list is not a claim of
  completeness: it names the secrets and execution surfaces someone thought of, and the mechanism gaps in §7 are gaps
  in the *mechanism*, not misses in the list.
- **`--script` code and library-supplied tools.** A script is executed with the operator's privileges by explicit
  decision (`src/cli/script.ts:305-310`); `ExecOptions.env` is "caller-supplied library code rather than model input"
  and always applies (`docs/sandbox.md:146-148`).
- **A tool that returns its own `ToolResult`.** It is trusted to have guarded itself; the loop passes it through
  (`src/tools-build.ts:41-46`).
- **The test suite and the mock model** (`src/testing/index.ts`). Test fixtures are not attacker input.

### UNTRUSTED inputs

- **Workspace file contents and names** — B2: hostile repository, checked-out branch, tarball, shared workspace.
- **Tool arguments** — B1: every path, pattern, `cwd`, task id and memory key the model chooses.
- **Tool output text** — B3: file bodies, `bash` stdout/stderr, MCP responses, provider-native results,
  `delegate_task` worker output.
- **Saved-agent config files and shellm frontmatter** — B4: schema-valid is exactly what an attacker plants
  (`docs/security.md:129-130`).
- **Scheduled-task status and lock files** — B5.
- **Process environment, when a shell runs** — B6.
- **Anything a model-controlled tool name or argument renders to the terminal** — B7.
- **MCP server definitions and `--provider-tool` names** are operator config, but the *responses* those servers and
  providers return are third-party content (B3) — and so is the **tool metadata the server authors**: the
  `description` and `inputSchema` each MCP tool advertises are server text that reaches the model's tool block
  unframed (`src/mcp.ts:271-281`). Choosing which servers to configure is the operator's trust decision; the
  words inside a configured server's tool metadata are that server's.

## 4. Controls, per surface

| Surface | Control | Where | Bead |
|---|---|---|---|
| Workspace reads | Default deny list: `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `.ssh/**`, `.aws/**`, `.gcloud/**`, `.kube/**`, `.git/objects/**`, `.git/hooks/**` | `src/tools/deny-list.ts:41-56` | #23 |
| Workspace writes | Same list plus `.git/**`, `node_modules/**`, `**/.github/workflows/**`, `**/.github/actions/**`, `**/.vscode/**`, `**/.devcontainer/**`, `**/.claude/**`, `**/.cursor/**`, `**/.husky/**`, `.mcp.json` — execution surfaces, because writing one is self-granted persistence | `src/tools/deny-list.ts:79-95` | agent-do-x6v6, agent-do-16de, agent-do-uush, agent-do-nc7i, agent-do-60j9 |
| Deny-list evaluation | Decided on a **canonicalised** path from one resolver shared with the store, through the substrate the I/O will use; a path the resolver cannot attest is blocked outright | `src/tools/deny-list.ts:182,260-280`; `src/stores/sandbox.ts:491` | agent-do-cn2, agent-do-kov, agent-do-ro9, agent-do-5ww, agent-do-vn9 |
| Workspace-supplied rules | `.agent-doignore` may only **add** restrictions; operator rules are absolute, so a `!` line cannot re-include `.env` | `src/tools/deny-list.ts:217-232` | agent-do-2wq |
| Deny-list feedback | The matched rule goes to `userSummary`/`data` but **not** `modelContent`, so the model cannot probe the policy by trial and error | `src/tools/deny-list.ts:384-396` | #23 |
| Listings and grep under the deny list | Denied entries filtered by canonical path, then re-rendered, re-framed and re-capped; guard stats describe the text actually returned | `src/tools/workspace-tools.ts:287-303,358-373` | agent-do-m5cz, agent-do-nurl, agent-do-gqul, agent-do-8trp |
| Listing names | `escapeForLine` escapes `\`, `\r`, `\n` so a filename cannot mint a second entry line | `src/tools/content-guards.ts:158-165` | agent-do-0fr, agent-do-2rm |
| All tool output into model context | `<tool_output …>` frame, injection-marker redaction, `<tool_output>` tags escaped so content cannot close its own frame, 256 KB read cap | `src/tools/content-guards.ts:23,46,84,196-241` | #48 |
| Bare tool returns | The loop's execute wrapper puts any non-`ToolResult` return through the same guards | `src/tools-build.ts:48,274` | agent-do-3qb |
| Provider-native tool output | Text framed/capped; JSON redacted in place (schema preserved, deliberately not framed or truncated) | `src/tools/provider-output-guard.ts:29-41,77` | agent-do-7hu, agent-do-dul |
| MCP | `stdio` transport refused where it cannot spawn; failures framed rather than returned bare. Tool **metadata** (server-authored `description`/`inputSchema`) is deliberately NOT framed — see §7 residual risks | `src/mcp.ts:186-189,271-281,330` | agent-do-5sh, agent-do-hvz, agent-do-a8pg |
| `delegate_task` | Worker output framed before it is read as data | `src/orchestrator.ts:42-59` | agent-do-4ya |
| Error strings | `sanitiseFsError` builds the model string from an errno allowlist, never `err.message`; only this repo's own guard messages pass through | `src/tools/content-guards.ts:269-300` | #45, #48 |
| Shell arguments | A model-supplied `cwd` is confined to the workspace root and refused if it escapes or cannot be attested; an absolute `cwd` needs an absolute root | `src/tools/shell-tool.ts:18-28,201-228` | agent-do-gfp6, agent-do-8iyt |
| Shell output | Framed, redacted, capped like any other tool result | `src/tools/shell-tool.ts:244-272` | agent-do-zfa, agent-do-dte |
| Provider credentials in a shell | Host connector forwards an allowlist of names (`PATH`, `HOME`, locale, `TMPDIR`, …), not the parent environment | `src/sandbox/connectors/host.ts:74-101`; `docs/sandbox.md:97-116` | 0.8 (was: whole environment) |
| Network from a shell | Connector-level, not a `SandboxApi` method: just-bash defaults `allowNet: false`, host has no policy | `src/sandbox/connectors/just-bash.ts:214`; `docs/sandbox.md:75-94` | #3 |
| Memory store containment | String-level `..` rejection, then canonical-to-canonical containment of the agent root | `src/stores/sandbox.ts:78-122`; `src/stores/filesystem.ts:68-115` | agent-do-qhn |
| Permission prompts | Read-only tools auto-approve; everything else prompts; non-TTY **fails closed** | `src/cli/permission-handler.ts:34-45,85-104` | #17, C-01 |
| Permission config | `mode: 'ask'` with no callback is rejected up front instead of falling through to allow | `src/permissions.ts:12-22` | agent-do-40r |
| Prompt text | Tool name and argument preview sanitised before they reach the TTY; preview truncates per-leaf then overall | `src/cli/permission-handler.ts:106-121,140-172` | agent-do-9zk, agent-do-193, agent-do-ht31 |
| Operator-facing output | Shared terminal-safety helpers neutralise control sequences; listings and cron rows use the single-line variants | `src/cli/terminal-safety.ts:42-107`; `src/cli/render.ts:26` | agent-do-9zk, agent-do-bc4, agent-do-wcq |
| Saved-agent configs | sha256 of the parsed bytes recorded by `agent-do create`; the `systemPrompt` is promoted only while the file still hashes to a recorded value, before the model is resolved and before tools are built | `src/cli/agent-trust.ts:21-32,160-173,267` | agent-do-5re |
| shellm `system:` | Same content-hash gate; the body is not gated because it is the task | `src/cli/shellm.ts:41-50` | agent-do-e29 |
| Saved-agent shape | Zod schema: bounded `providerTools` names, relative `memoryDir` with no `..`, strict object. Shape only — see B4 | `src/cli/agents.ts:40-88` | #22 |
| `--script` | Positional must be inside cwd, needs `--script`, and prompts unless `-y`; size capped | `src/cli/script.ts:29-37,305-310` | C-03 |
| Scheduler | Status validated per entry on read (zod, plus `__proto__`/`constructor`/`prototype` skipped), invalid shape falls back to `{}`; runs serialised by an `O_CREAT\|O_EXCL` lock with mtime-based stale reclaim | `src/scheduled-tasks/fs.ts:29-83,140-158`; `src/stores/file-lock.ts:100-120` | agent-do-0nf, #15, #79 |
| Cron rows | Emitted values made structurally inert: newlines collapsed, `%` escaped, one row per task | `src/cli/scheduled-tasks-cmd.ts:140-215` | agent-do-hvh, agent-do-bw1 |
| Grep patterns | Literal substring by default; regex mode capped in length and rejected for catastrophic-backtracking shapes | `src/stores/search-matcher.ts:5-60`; `src/tools/file-tools.ts:315-325` | H-02, M-02, PR #63 |
| Skill installation | `install_skill` withheld from the model unless the caller opts in, so a prompt-injected agent cannot rewrite its own future system prompt | `src/skills.ts:502-516,641` | #24, H-05 |
| Skill bodies in the prompt | Wrapped in `<skill>` markers with a "reference material, not instructions" preamble | `src/skills.ts:109-128` | #24 |
| Read/write size | 256 KB model-facing read cap, 1 MB write cap — cost and context, not confidentiality | `src/tools/content-guards.ts:23-26` | #48 |

## 5. Bug-shape hints from history

Each family below was found, fixed, and then found again somewhere else. The lesson is the general form.

- **Two resolvers that disagree** (`agent-do-cn2`, `-kov`, `-ro9`, `-5ww`). Policy judged the model's string while
  the store judged something else, so a legal `foo/../.env`, an in-workspace symlink, a substrate-only symlink and a
  fresh write through a symlinked directory each got past. Lesson: one resolver, shared. Ask which resolver a new
  path-reading code path uses, and whether it is that one.
- **The name, not the file** (`agent-do-qhn`, `-ajs`, `-vn9`, `-34f`, `-a10`, `-utb`, `-108`). Canonical
  resolution is only as good as what it can attest: a link it can see but not read, a stat record that is not
  validated, a capability shortcut that skipped the walk. Lesson: "cannot attest" must deny, and the absence of a
  primitive decides how the walk ends, not whether it happens.
- **Glob anchoring and depth** (`agent-do-uush`, `-nc7i`, `-16de`, `-60j9`, `-x6v6`). `'.vscode/**'` is anchored to
  the workspace root, so a monorepo subfolder was writable; the devcontainer spec's single-file form was covered
  separately from its directory form; `.husky/**` was git-hook persistence one directory over from `.git/hooks/**`.
  Lesson: a deny pattern is a claim about *every* path that reaches the asset — check the depth-independent form and
  every spelling of the file.
- **The workspace supplies policy for its own guard** (`agent-do-2wq`). `.agent-doignore` was concatenated into the
  same `ignore` instance as the defaults, so a committed `!.env` line re-included what the defaults denied. Lesson:
  input from the untrusted side may only tighten. Ask of any config file the guard reads: who can write it?
- **A line-oriented format with an unescaped separator** (`agent-do-0fr`, `-2rm`, `-bc4`, `-wcq`, `-hvh`, `-bw1`).
  A filename with a newline minted a listing entry; a description with a newline minted a crontab row that system
  cron executed; an unescaped `%` cut a cron command in half; an unsanitised table field forged a row. Lesson:
  escape the separator in every field of every emitted line-oriented format, and check the second command as well as
  the first (`agent-do-l7at` is the same shape in the gate scripts).
- **A new tool surface starts unframed** (`agent-do-3qb`, `-7hu`, `-hvz`, `-dte`, `-nurl`, `-m5cz`, `-4ya`, `-zfa`,
  `-gqul`, `-8trp`, `-dul`). Caller-registered tools, provider-native tools, MCP errors, shell output, `memory_list`,
  `find_files` and `delegate_task` each reached the model ahead of the guard at some point. Lesson: the guard belongs
  in the shared wrapper, not in each tool; when adding a surface, find the line where its text enters
  `modelContent` and confirm it passes through `wrapForModel` / `sanitiseUntrustedText`.
- **Model-chosen text in the authorisation prompt** (`agent-do-193`, `-9zk`). A tool name or argument rewrote the
  line the human was about to answer, and the first fix guarded only one of the two writes in the file. Lesson: the
  prompt that asks for permission is itself an output surface; sanitise every write to it, including the refusals.
- **Fail-open in the mode that exists to fail closed** (`agent-do-40r`). `mode: 'ask'` with no callback fell through
  to allow. Lesson: a "must never silently permit" path needs an assertion, not a comment.
- **Instructions from a file nobody vetted** (`agent-do-5re`, `-e29`, `-fhu`, `-6bu`). `findAgentFile` walks *up*, so
  `.agent-do/agents/*.json` and `.shellm` frontmatter arrive with a clone; the Zod schema validates shape, and a
  schema-valid hostile file is exactly what an attacker plants. Lesson: provenance is a separate question from
  validation — record what the operator sanctioned, and gate the tier that carries instructions.
- **An argument that walks past the tool's own root** (`agent-do-gfp6`, `-8iyt`, `-dte`). A model-supplied `cwd` went
  straight to `SandboxApi.exec` and the deny list never saw it; then a relative root let `/etc` read as inside `.`.
  Lesson: every argument that names a location is a path-policy input, even on a tool that is not the file tool.
- **Untrusted structure on read** (`agent-do-0nf`). A status file is JSON from a possibly shared directory; a
  non-numeric field crashed the status printer with a `RangeError`, and a `__proto__` key could shadow
  `Object.prototype`. Lesson: parse as hostile — validate every entry and skip prototype keys.

## 6. Security invariants for auditors

- A path the resolver cannot attest never reaches an I/O call, on either the file-tool path or the store path
  (`src/tools/deny-list.ts:262-280`; `src/stores/sandbox.ts` resolve). **Test it per tree:** at the pinned tree
  `a151c46` the store path has an exception — `resolve` short-circuits on `!sandbox.realpath` and returns the
  name un-walked (`src/stores/sandbox.ts:107`), so the invariant holds on the store path only when the connector
  exposes `realpath`. `agent-do-ws1u` (fleet/imp-1-ulkp, in review) removes that short-circuit; once it lands,
  the invariant is unconditional on both paths.
- The deny list's `modelContent` never echoes the matched rule (`src/tools/deny-list.ts:384-396`).
- Every string that becomes `ToolResult.modelContent` from a source outside this process is framed, redacted and
  capped — or returns a `ToolResult` that says why it is not.
- Operator rules and workspace-supplied rules are never merged into one matcher (`src/tools/deny-list.ts:217-232`).
- No unsanitised model-chosen value is written to a TTY, a log line, an emitted crontab row, or a listing row.
- An instruction tier (saved-agent `systemPrompt`, shellm `system:`) is reachable only through the content-hash trust
  gate (`src/cli/agent-trust.ts:267`).
- `mode: 'ask'` never resolves to allow without a human or an explicit flag (`src/permissions.ts:12-22,60-63`).
- A shell's environment is an allowlist, not the parent environment, unless the operator asked otherwise
  (`src/sandbox/connectors/host.ts:74-101,186`).

## 7. Accepted residual risks

### 7.1 Documented and accepted

- **The shell tool bypasses the deny list entirely.** `cat .env` returns what `read_file('.env')` blocks
  (`docs/security.md:16-23`; `docs/sandbox.md:275-279`). Guidance: if you grant shell execution, treat every file in
  the workspace as readable by the model.
- **Hard links are not covered by a path policy.** `fs.link('.env', 'notes/readme.txt')` is readable as
  `notes/readme.txt`, because there is nothing to canonicalise; the file tools cannot create a link, but a shell in
  the same sandbox can (`docs/security.md:35-45`; `docs/sandbox.md:280-287`).
- **`userSummary` is deliberately unframed** — operator logs want the raw diagnostics, and an operator reading an
  injection attempt is how it gets reported (`docs/security.md:83-86`).
- **Redaction is a cost-raiser, not a solution.** It catches the obvious openers; a hostile page phrased as ordinary
  results still reads as ordinary results (`src/tools/content-guards.ts:1-14`; `docs/security.md:112-116`).
- **A custom tool returning a `ToolResult` opts out of the guards** (`src/tools-build.ts:41-46`).
- **Content a provider synthesises into its own answer is not framed** — grounded answers and citations arrive as
  assistant text, not tool results (`docs/security.md:109-113`). Provider JSON payloads are also not byte-capped,
  for schema reasons (`src/tools/provider-output-guard.ts:35-41`).
- **The host connector is not a security boundary**: same user, same PID namespace, so `/proc/$PPID/environ` still
  reads the parent's credentials, and it has no network policy (`docs/sandbox.md:75-94,126-135`).
- **MCP tool metadata reaches the model unframed**: a server's `description` and `inputSchema` pass into
  `dynamicTool` as-is (`src/mcp.ts:271-281`), so a hostile or compromised server can put instructions in the text
  the model reads alongside its tools, and a pathological schema can be large. Accepted because the schema must
  reach the model verbatim for calls to typecheck, the description is the server's own contract, and the
  operator's choice of server is the same trust decision as running its tools — do not configure servers you do
  not trust (`agent-do-a8pg`).
- **`readOnly` / `onBeforeWrite` are soft hooks**, not a boundary; a tool calling `node:fs` directly bypasses them
  (`docs/sandbox.md:209-220`).
- **Store containment is string-level for a connector with no `realpath`** — live at `a151c46` and at this
  document's own pinned tree (`src/stores/sandbox.ts:107`: the short-circuit judges a planted alias by its own
  name, in tension with `docs/sandbox.md:257-259`). **Fix in review**: `agent-do-ws1u` (fleet/imp-1-ulkp)
  removes the short-circuit; the walk becomes unconditional and a link a connector can see but cannot read is
  refused. Mark this risk CLOSED only once that branch has landed.
- **File locks are advisory and mtime-based**; a process that writes without acquiring the lock can clobber a locked
  file, and 1s mtime granularity plus a 60s stale threshold is the accepted trade (`src/stores/file-lock.ts:25-41`).
- **`.agent-doignore` is not read for sandbox-backed workspaces** (`skipAgentDoIgnore` is forced), so a virtual root
  gets the defaults and `--exclude` only (`docs/sandbox.md:286-288`).
- **The installed gate config, not the branch's, is what runs.** `tools/install-gate.sh` refuses a `check.conf` that
  is not on `origin/main`, so a lane's fast-gate verdict is produced under the installed windows; installing an
  unlanded config is the logged `INSTALL_GATE_ALLOW_UNLANDED=1` escape hatch and must be reconciled when the branch
  lands or dies (`tools/install-gate.sh:22-50`; `docs/speed.md:252-257`). The risk accepted is a green verdict that
  describes a config main's tests do not pin.
- **An operator who opts out of a control gets what they asked for**: `--accept-all`, `--include-sensitive`,
  `--trust-agent-config`, `--script` (`SECURITY.md` "Likely out-of-scope"; `docs/security.md:56,149-152`), and a run
  already executing arbitrary shell commands *has* the workspace. The controls above exist so that point requires a
  visible decision.

### 7.2 Open in this tree, tracked

Both are real bypasses of an operator's stated intent at commit `a151c46`; neither is documented as a design choice.

- **A session `always` is keyed on the tool name, not the call.** `sessionApproved.has(req.toolName)`
  (`src/cli/permission-handler.ts:86,123-126`) means answering "always" to one `write_file` authorises every later
  `write_file` in the run — which is what the header comment describes as intended scope ("once per (tool, session)",
  `src/cli/permission-handler.ts:15-17`), but it is broader than the argument the human actually read in the prompt.
  Tracked as `agent-do-ulkp`, which narrows a grant to one exact call.
- **`--no-tools` does not narrow a saved-agent run.** `effectiveNoTools = saved.noTools`
  (`src/cli/script.ts:476`) ignores the flag, while `--read-only` *is* OR-ed in (`src/cli/script.ts:477`), so the two
  restriction flags behave asymmetrically and the sandbox warning correctly reports the resolved state rather than
  the flag (`src/cli/warnings.ts:11-18`). Tracked as `agent-do-u3bv`.
