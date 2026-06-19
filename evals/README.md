# agent-do evals

Behavioural and quality eval suites for agent-do, run through the shipped
`agent-do/eval` framework.

## Two tiers (cost-safe by design)

| Tier | Command | Model | Cost | CI |
|------|---------|-------|------|----|
| **Mock** | `npm run eval` | `createMockModel()` (scripted) | **free** | ✅ runs on every PR |
| **Live** | `npm run eval:live` | real provider | real money | ❌ opt-in only |

### Mock tier — what it checks

Deterministic regression coverage of the **plumbing**: the loop dispatches a
tool call, the tool writes to the store, the assertion sees it, steps stay
within budget, permissions/hook wiring holds. Each case in `behaviour.ts`
carries its own scripted `responses`, so the suite is fully isolated and
order-independent.

The mock returns canned text regardless of what the tools returned, so the
mock tier does **not** measure model quality — add those cases to the live
tier.

### Live tier — what it checks

Real model quality against `quality.live.ts`: factual recall, tool-use
correctness, and `llm-rubric` judged explanations. It resolves the model
through the same provider path as `npx agent-do`, so it exercises the CLI's
`resolveModel` too. Skipped automatically when no API key is set.

## Running

```bash
# Mock — always safe, no key needed
npm run eval

# Live — needs a provider key
export ANTHROPIC_API_KEY=sk-ant-...
npm run eval:live

# Live against a different provider / model
EVAL_PROVIDER=google EVAL_MODEL=gemini-2.5-flash npm run eval:live
EVAL_PROVIDER=zai      EVAL_MODEL=glm-4.6           npm run eval:live
```

Both scripts exit non-zero on any failure, so they're safe to gate CI or a
pre-commit hook on.

## Adding a case

- **Plumbing regression** → add a `MockEvalCase` to `behaviour.ts` with
  scripted `responses` and assertions. It runs in CI for free.
- **Quality** → add an `EvalCase` to `quality.live.ts`. Keep it small and
  prefer cheap models by default; `llm-rubric` adds a judge call.

The assertion types are documented in the README and in
`src/eval/types.ts` (13 types: `contains`, `regex`, `tool-called`,
`tool-args`, `file-contains`, `max-steps`, `max-cost`, `llm-rubric`,
`custom`, …).

## Why split tiers?

Provider calls are the single biggest source of eval cost. Running quality
evals on every push is unsustainable; running *no* evals lets regressions
slip. The mock tier gives a free, fast gate that catches the most common
breakage (plumbing), while the live tier is run deliberately — before a
release, or on a schedule — when the spend is justified.
