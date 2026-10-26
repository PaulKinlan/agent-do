# agent-do — test tiers and gate budgets

**Owner:** the `architect` role, with the fleet standard in `~/fleet/docs/speed.md` as the parent document.
This file is the *local* instantiation of it: the commands, the measured numbers, and the local decisions a
reviewer or a lane needs. Where the two disagree, the local file wins for this repo, and the disagreement is
a finding.

**Why it exists at all:** as of 2026-10-12 this repo had no gate configuration on its VM — `~/.fleet/check.conf`
held another project's commands, so `fleet-check` in an agent-do worktree either ran the wrong suite or
nothing. The full suite is fast today (~21 s), which is exactly why the tier has to be built *now*: the fleet
standard measured a suite that grew 287 → 1 515 tests in five days with no budget, 25 s → 358 s, and by then
every landing paid for it.

## 1. The two gates

| gate | command | what it runs | measured (2026-10-22, see §4) | budget |
|---|---|---|---|---|
| **full** | `bash tools/full-gate.sh` | STATIC_CMD, then every suite + the mock-tier evals | **313 s at 4 workers, 356 s at one** | ≤ 300 s (R1) |
| **fast** | `bash tools/fast-gate.sh` | STATIC_CMD, then the suites that reach the changed files | **247 s** worst row at the default 2 workers (see §4) | ≤ 60 s (R2) |

`fleet-check --fast` runs the fast gate; `fleet-check` runs the full gate. **Only the merger runs the full
gate** (R13) — `bin/fleet-check` refuses it from any other lane unless the lane passes `--full`, because
measured fleet-wide 915 of 1 781 full-gate runs came from non-merger lanes (54 h of VM time). An implementer
that needs the full gate (a dependency change, see §5) asks for it explicitly and says why on the bead.

The commands are named in exactly one place, `tools/gate.conf`, and they are installed onto the VM from
`tools/check.conf` by `tools/install-gate.sh` (or by `fleet new` / `fleet scaffold`).

Measured environment: **2 vCPU / 8 GiB** (`nproc` = 2) — half the fleet standard's assumed shape, so every
number above is an upper bound for an 8-vCPU VM, not a lower one.

## 2. The tiers, and where a new test goes

| tier | what it is | where it lives | who pays |
|---|---|---|---|
| **static** (`STATIC_CMD` = `npm run build`) | `tsc` over `src/`, `tests/`, `evals/`, emitting `dist/` | the same command in **both** gates (R8: never twice) | every gate |
| **unit** (`FAST_GATE_RUNNER` = `npx vitest run`, one invocation, test files parallelised inside it) | vitest suites; a test file is the unit of parallelism | `tests/**/*.test.ts` | the fast gate selects the affected ones; the full gate runs all 46 |
| **eval** (`npm run eval`, inside `FULL_TIER_CMD`) | the credential-free mock tier of `evals/` | `evals/` | the full gate only (it is one command, so affected-only selection cannot reach inside it) |

Two consequences worth stating out loud:

- **The static step is in the fast gate on purpose.** This is a TypeScript repo and vitest transpiles
  *without* type-checking, so without that step a changed file with a type error would be green on the fast
  gate and red on the merger's build — the lane round-trip the fleet standard exists to remove. It is also
  why the fast gate has a floor of ~13 s: the whole-program type-check is the dominant cost, and it is
  deliberately *not* affected-only (tsc has no sound way to check one file of a program in isolation).
  **This is the next lever if the suite grows:** the static step and the suites are independent, so running
  them concurrently would cut the widest case from 55 s to ~42 s; it was left sequential because a
  concurrent failure blurs the `fast-gate:` marker vocabulary the fleet's coverage extractor parses.
- **A new test goes in the unit tier** unless it needs credentials (→ `evals/quality.live.ts`, not in any
  gate) or drives a demo end-to-end (→ the CI demo-smoke job, §5).

## 3. Affected-only selection, and the file that decides it

`tools/suite-map.tsv` is the only place affected-only selection is decided (R5). It is **generated** by
`tools/gen-suite-map.mjs` from the real test import graph — each module is listed with *every* suite that
reaches it through relative imports (including `vi.mock(...)` targets, which are dependencies the graph would
otherwise miss). One row per module, never a directory-wide glob: with `src/*.ts` a brand-new module would
inherit the suites of its neighbours, i.e. claim coverage that never existed.

### Suites that read source as DATA — `// @reads <glob>`

The graph sees imports, so it cannot see a suite that `readFileSync`s source text and asserts on it (a
stdout-safety invariant, a secret scan, an import rule). Without a declaration such a suite is invisible to
selection: a change to a file it inspects maps to the suites that *import* that file, the invariant is not run, and
the gate reports PASS while the invariant is broken. Measured once (agent-do-9im): the fast gate passed on a change
to `src/cli/eval-cmd.ts` while `tests/cli-answer-stream.test.ts` failed on it, and a reviewer found it, not the gate.

So a suite can declare what it reads, in the suite itself:

```ts
// @reads src/cli/*.ts
```

`tools/gen-suite-map.mjs` adds every matching module to that suite's row, exactly as if it had imported them, so the
invariant is selected whenever a file it inspects changes. The marker uses the same bash-pattern dialect as the map's
rows (`*` crosses `/`), it lives with the code that does the reading rather than in a sidecar that drifts, and it is
covered by `tests/gates.test.ts` (which asserts every `src/cli` module maps to the stdout invariant).

The same graph also writes **`tests/coverage-contract.json`**, and that file is not a duplicate — it exists
because a *second* consumer decides "was this changed file exercised?", and it is not ours.
`~/fleet/remote/check-coverage.py` (the fleet's coverage extractor, which writes the `coverage` block a
reviewer reads in `~/.fleet/checks/<tree>.fast.json`) does **not** read `suite-map.tsv`: it looks for a test
file whose *name* corresponds to the changed file. Without a contract, every module whose suite is not
eponymous — `src/cli/args.ts` → `tests/cli-args.test.ts`, every `tools/*.sh` → `tests/gates.test.ts` — is
published as `unmapped` in the record at the moment its suites really did run, which is the same
"consumer and producer disagree" defect as R15, one layer down. The contract is that extractor's sanctioned
hook, and it has a side benefit: because the extractor requires *every* contract-named suite to have run, it
becomes an independent mode-(b) check that this file cannot be.

`--check` mode fails when either committed file is stale, and `tests/gates.test.ts` runs it — so **both gates
enforce it** and neither can rot:

```bash
node tools/gen-suite-map.mjs          # rewrite tools/suite-map.tsv + tests/coverage-contract.json
node tools/gen-suite-map.mjs --check  # what the gates run
bash tools/fast-gate.sh --list        # what the fast gate WOULD run, running nothing
```

### The two failure modes, and which one the fast gate can see

The fleet standard measured this (`fleet-1n0z`): an affected-only selector is a false-green generator.

- **(a) a changed module that maps to ZERO suites** — *detectable, and detected*: the gate prints
  `fast-gate: unmapped: <path>` and exits 1 without running anything. A silent no-op gate still exits 0 and
  reports a pass, which is the failure this whole file exists to prevent.
- **(b) a module that maps to SOME but not all of its covering suites** — *not detectable* from the map.
  The generation from the import graph is what makes (b) unlikely here (the closure is complete by
  construction), but it is not proof: the independent oracle is the **full gate on the merged union**, which
  is why the merger runs it and why the fast gate's green means (a) only.

### Exemptions — each one is a claim, on the line

| pattern | the claim |
|---|---|
| `docs/**`, `**/*.md`, `llms.txt` | prose; a wrong doc is a docs-drift finding, not a test failure |
| `.github/**`, `.changeset/**`, `LICENSE`, `.gitignore` | not code; CI config is exercised by running it |
| `typedoc.json` | API-docs build config; `npm run docs` is a separate CI job |
| `tsconfig.json` | type-level only, and `STATIC_CMD` compiles the whole program in *both* gates |
| `scripts/**` | release/changelog tooling, exercised by running a release |
| `examples/**` | credential-requiring single-feature examples, run by hand (AGENTS.md rule 2) |
| `demos/**` | the consumer-surface check; the CI job "Demo smoke (no credentials)" runs `tsc` + `tsx` per demo |
| `evals/**` | one command, not per-file suites; covered by the full gate and by CI's eval job |

An exemption means "no suite can **ever** cover this", not "this is safe".

## 4. The budget, honestly

Measured 2026-10-22 on a 2-vCPU VM, `bash tools/fast-gate.sh --changed src/tools/content-guards.ts` (the
widest row in the map, now **43 suites**), after `agent-do-664` made the worker count actually reach the
runner:

| workers | vitest | of which import | fast gate (incl. static) | suites |
|---|---|---|---|---|
| 1 (what the gate did before `agent-do-664`: `FAST_GATE_JOBS` was declared and never used) | 419 s | 127 s | **450.8 s** | 43/43 |
| **2 (the new default: one worker per vCPU)** | 216 s | — | **247.4 s** | **43/43** |
| 4 | 137 s | 279 s | **168 s** | 42/43 (a 5 s default timeout) |
| 4, measured straight after another gate (contended) | — | — | **327 s** | 42/43 |
| 4 + `--no-isolate` (experiment, not shipped — see below) | 58 s | 98 s | **115 s** | 41/43 |

2 workers is the default because it is the row that is both fast and green: four workers on two cores is
oversubscription, and the 5 s default timeout becomes a lottery — `tests/loop.test.ts` and
`tests/build-script.test.ts` failed at 4 workers and pass serially. The same reasoning retired the idea of
putting `maxWorkers` in `vitest.config.ts`: that would parallelise the full gate too, where it measured 313 s
against 356 s serial (~12%) and failed three tests that pass serially. The full gate therefore stays serial
and stable; the parallelism is applied where it pays, to the wide-but-not-full selections the fast gate runs.

Read it as: **the fast tier is 4–8× over its 60 s budget (R2) on this VM, and the previous table in this
section (13.6 – 55.0 s, 36 suites, measured 2026-10-12) was stale on both axes** — the widest row has grown
to 43 suites, and the number was never re-measured after vitest 4 arrived. That is the honest reason two
implementer lanes could not clear a fast gate at all on 2026-10-22, not an unlucky VM.

The cost is **per-file module import**, not test work: 279 s of import against 109 s of tests for 43 files at
4 workers. `isolate` (vitest's default) gives every file a fresh module registry, so each one pays the AI
SDK graph again. The measured lever is `--no-isolate`: 58 s of vitest for the same 43 suites — but it is
**not shipped here**, because it leaked state between files on the first try (`tests/mcp.test.ts` and
`tests/cost-runaway.test.ts` failed in ways they do not fail isolated). Untangling that per suite is an
architect-sized job (which suites mutate module or process state), not a gate-bound change; §6 P1 is the
same pathology seen from the other side.

The full gate's own split (59 files / 1 247 tests): 356 s at one worker (static ~35 s, vitest 314 s, evals ~1 s) and 313 s at 4 workers (vitest 268 s) — so on the whole suite set the parallelism buys ~12%, because two cores are the constraint; where it pays is a wide selection that is not the whole set, which is what the fast gate runs. The
bounds in `tools/check.conf` (**1200 s** / 480 s) are kill windows ~2.1× (against the worst healthy full-gate
run measured, 563 s) and ~1.5× (against the worst fast observation of 327 s) rather than the ~11×/~3× they
were: a bound must exceed the real run
(`roles/lessons.md`), and a 180 s window against a 168–327 s run reports healthy runs as
all-suites-failed. The fast gate's *batch* bound (`SUITE_BOUND`, 400 s; it bounds the single runner
invocation, so a wedge is reported against every suite it selected rather than one) stays deliberately below
the outer 480 s window: it has to be the one that fires, so a hung suite is reported as
`fast-gate: failed: <suite>` with its log tail, instead of the outer kill recording the whole gate as
`unknown` and losing which suite wedged. `tests/gates.test.ts` asserts the relationship against
`tools/check.conf`, so raising one bound alone goes red.

The full gate's window was 600 s until 2026-10-26, and the numbers that retired it are worth recording
because they are the failure mode the window exists to avoid: **600 s was 94% of the worst healthy
observation (563 s), and under concurrent lane load it fired twice on the same tree** — killed at 601 s and
616 s with vitest actively passing suites in the log tail, while another lane ran a 1587 s build on this
2-vCPU VM. Both recorded UNKNOWN (INTERRUPTED). UNKNOWN is the one outcome that costs a landing without
saying anything about the code, and for a `package-lock.json` change there is no second opinion to seek,
because the fast tier refuses it by design (§5). The wider window costs only the wedged case: a hung full
gate holds its heavy slot for up to 20 min instead of 10, still well inside the reaper's 120 min. It
remains a kill window and not a budget — 600 s of wall is still the target, and the levers below are how to
reach it.

Loosening a bound is not a budget fix. The ordering that would get this repo back inside R2 is: (1) a shared
module graph for suites that are shown not to leak state (`--no-isolate`, measured 115 s), or (2) fewer
suites reaching the central surfaces (R6/R7), or (3) a smaller static step. Until one of those lands, the
numbers above are the truth and the bounds say so.

## 5. Changes the fast tier refuses (and why that is deliberate)

`package.json`, `package-lock.json` and `vitest.config.ts` are **not in the map and not exempt**. The fast
gate names a change to any of them `unmapped` and exits 1. This is a decision, not an omission:

- a dependency or lockfile change is not local — it can reach every suite — and R2 requires the fast tier to
  stay a **strict subset** of the full gate, so the fast gate may not simply run everything;
- `vitest.config.ts` decides *which* tests run, so a change to it invalidates every selection decision;
- the honest answer for all three is "this is a full-gate change". Land `npm run release` version bumps and
  dependency bumps through the merger's union gate, or ask for `fleet-check --full` as a lane and say why.

Anything else unmapped is a prompt to act, not a rule to work around: **run `node tools/gen-suite-map.mjs`
first** (a module with a suite is normally mapped already — the map is generated), and if the module really
has no suite, the fix is the suite, not an exemption.

## 6. A gate that can fail for reasons outside the diff is a defect

Three named pathologies from the fleet standard, and what each means here:

- **P1 — shared mutable state.** A suite that writes a path the host or another suite owns is red or green
  depending on order. The fleet has already had a suite clobber the VM's `~/.fleet/check.conf` and destroy
  the gate config. Here: `tests/gates.test.ts` builds a throwaway repo under `mkdtemp` per case and never
  touches the real `tools/`; 14 files under `tests/` use `mkdtemp`. Check with
  `grep -rnE 'os\.homedir|process\.env\.HOME|/tmp/[a-z]+' tests/`.
- **P2 — order dependence.** No suite may depend on another's side effects. Run one suite per process (which
  the fast gate does) and the tier in isolation, and both must be green.
- **P3 — asserting on the machine.** No wall-clock latency bounds, no fixed ports, no assertions about other
  lanes' files. `tests/file-lock.test.ts` is the suite to watch here: it has two `setTimeout`s, and both are
  inside waits for a real resource (a lock), not latency bounds — keep it that way. A gate bound that fires
  (exit 124/137/143) reads as **unknown**, never as a pass. When a fix has a cost claim attached, the suite
  asserts the deterministic half and the timing goes in a benchmark that neither gate runs —
  `npx tsx tools/bench-redact-cost.mjs` for the tool-output redaction walk (agent-do-t23), which is how
  agent-do-ztb's quadratic close search is still caught without a wall-clock assertion in CI.

## 7. Speed is a design constraint for a change, not only for a gate

- **One owner per file, small surfaces** (R6). The collision list is
  `git log --first-parent --since=30.days --name-only --format='' origin/main | sort | uniq -c | sort -rn | head`
  — a non-generated file at the top of it is where every lane rebases and where every landing waits.
- **Keep the change local.** A change that must touch a dozen files, or a file every other lane is editing,
  is a design finding: say so on the bead and propose the split instead of pressing on.
- **Never make the fast gate slower without saying so.** If a change moves the numbers in §4, update the
  table in the same commit and say what the new median is in the landing summary.
- **Batch the landing** (R11): one full gate per union of cleared branches, not one per branch.

## 8. How to check this file is still true

```bash
bash tools/fast-gate.sh --list          # the selection the fast gate would make
node tools/gen-suite-map.mjs --check    # both generated files match the import graph
npx vitest run tests/gates.test.ts      # the gate's own suite (11 cases: fail-loud, markers, map truth)
~/fleet/bin/fleet-budget                # this VM's gate medians against the budgets (R1/R2)
~/fleet/bin/fleet-budget --fast
```

`tests/gates.test.ts` also enforces that **every module under `src/` has a map row or a recorded reason it
has none** (the list and its reasons are in that file). A new module with no suite therefore fails this
repo's own suite: the fix is the suite, or a row with a reason — never a silent gap.
