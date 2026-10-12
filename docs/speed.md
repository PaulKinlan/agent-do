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

| gate | command | what it runs | measured (2026-10-12) | budget |
|---|---|---|---|---|
| **full** | `bash tools/full-gate.sh` | STATIC_CMD, then every suite + the mock-tier evals | **41.5 s** | ≤ 300 s (R1) |
| **fast** | `bash tools/fast-gate.sh` | STATIC_CMD, then the suites that reach the changed files | **13.6 – 55.0 s** (see §4) | ≤ 60 s (R2) |

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
| **unit** (`FAST_GATE_RUNNER` = `npx vitest run`, one file per process) | vitest suites; a test file is the unit of parallelism | `tests/**/*.test.ts` | the fast gate selects the affected ones; the full gate runs all 46 |
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

`--check` mode fails when the committed map is stale, and `tests/gates.test.ts` runs it — so **both gates
enforce it** and the map cannot rot:

```bash
node tools/gen-suite-map.mjs          # rewrite tools/suite-map.tsv
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

Measured 2026-10-12 on a 2-vCPU VM, `bash tools/fast-gate.sh --changed <file>`:

| change | suites selected | fast gate |
|---|---|---|
| `tools/fast-gate.sh` (its own suite) | 1 | 13.6 s |
| `src/tools/deny-list.ts` | 4 | 17.2 s |
| `src/skills.ts` | 14 | 32.2 s |
| `src/mcp.ts` | 32 | 47.2 s |
| `src/tools/content-guards.ts` (the widest row in the map today) | 36 | **55.0 s** |

Read it as: **median ≈ 17 s, worst case 55 s of a 60 s budget.** The tail is thin, and it is thin for a
structural reason worth naming: `src/tools/content-guards.ts` and `src/agent.ts` sit under almost every
suite, so a change there is *genuinely* a wide change — the closure is correct, and the honest reading is
that the widest changes are not far off the full gate (41.5 s) in cost. That is a property of the module
graph, not of the selector. The levers, in the standard's order: the concurrent static step (§2, ~42 s), and
R6/R7 (smaller central surfaces) if the widest rows keep growing.

The full gate's own split (41.5 s): static 13.8 s, vitest 21.0 s (46 files / 870 tests), evals 1.4 s. The
bounds in `tools/check.conf` (600 s / 180 s) are kill windows ~11× and ~3× the measurements: a bound that
fires means the gate wedged, not that it was slow.

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
  (exit 124/137/143) reads as **unknown**, never as a pass.

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
node tools/gen-suite-map.mjs --check    # the map matches the import graph
npx vitest run tests/gates.test.ts      # the gate's own suite (11 cases: fail-loud, markers, map truth)
~/fleet/bin/fleet-budget                # this VM's gate medians against the budgets (R1/R2)
~/fleet/bin/fleet-budget --fast
```

`tests/gates.test.ts` also enforces that **every module under `src/` has a map row or a recorded reason it
has none** (the list and its reasons are in that file). A new module with no suite therefore fails this
repo's own suite: the fix is the suite, or a row with a reason — never a silent gap.
