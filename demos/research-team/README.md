# Multi-Agent Research Pipeline

A multi-agent orchestrator where a Master agent coordinates a Researcher and Writer to produce a polished research report on any topic.

## What it does

- **Master agent** -- Receives a topic and breaks it into research and writing tasks.
- **Researcher agent** -- Gathers information and key facts about the topic.
- **Writer agent** -- Takes research output and drafts a polished, structured report.
- **Real-time progress** -- Logs which agent is active and what tools they are calling.
- **File output** -- Saves the final report to `.data/master/reports/` as a markdown file (scoped under the master agent's ID by `FilesystemMemoryStore`).

## How to run

```bash
# Install repo root dependencies first (if not already done)
# (cd ../.. && npm install)

# Install demo dependencies
npm install

# Set an API key for any supported provider:
export ANTHROPIC_API_KEY=sk-ant-...            # Anthropic (default)
# export GOOGLE_GENERATIVE_AI_API_KEY=...      # Google / Gemini
# export OPENAI_API_KEY=sk-...                 # OpenAI

# Run with a topic (passed as argument or prompted)
npm start "Rust programming language"
npm start "the history of the internet"
npm start  # prompts for a topic interactively
```

This demo auto-detects the provider from whichever API key is set. To force a specific provider when multiple keys are present, set `DEMO_PROVIDER=anthropic|google|openai`. Default model IDs differ per provider — see [demos/README.md](../README.md#choose-a-model-provider) for the full env surface.

## What to expect

1. The master agent receives the topic.
2. Progress logs show delegation: "Master delegating to Researcher...", "Researcher working...", etc.
3. The researcher returns findings to the master.
4. The master delegates writing to the writer agent.
5. The writer drafts a structured report.
6. The master saves the report to `.data/master/reports/`.
7. The final report is printed to the console.

## Architecture

```
User (topic)
  |
  v
Master Agent (master model — e.g. claude-opus-4-7 / gemini-3.1-pro-preview / gpt-5.4)
  |--- delegate_task("researcher", "Research X...")
  |      |
  |      v
  |    Researcher Agent (worker model — e.g. claude-haiku-4-5)
  |      returns findings
  |
  |--- delegate_task("writer", "Write a report using...")
  |      |
  |      v
  |    Writer Agent (worker model)
  |      returns polished report
  |
  v
Final report saved to .data/master/reports/
```
