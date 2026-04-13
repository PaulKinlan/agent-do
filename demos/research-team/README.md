# Multi-Agent Research Pipeline

A multi-agent orchestrator where a Master agent coordinates a Researcher and Writer to produce a polished research report on any topic.

## What it does

- **Master agent** -- Receives a topic and breaks it into research and writing tasks.
- **Researcher agent** -- Gathers information and key facts about the topic.
- **Writer agent** -- Takes research output and drafts a polished, structured report.
- **Real-time progress** -- Logs which agent is active and what tools they are calling.
- **File output** -- Saves the final report to `.data/reports/` as a markdown file.

## How to run

```bash
# Install dependencies
npm install

# Set your API key
export ANTHROPIC_API_KEY=sk-ant-...

# Run with a topic (passed as argument or prompted)
npm start "Rust programming language"
npm start "the history of the internet"
npm start  # prompts for a topic interactively
```

## What to expect

1. The master agent receives the topic.
2. Progress logs show delegation: "Master delegating to Researcher...", "Researcher working...", etc.
3. The researcher returns findings to the master.
4. The master delegates writing to the writer agent.
5. The writer drafts a structured report.
6. The master saves the report to `.data/reports/`.
7. The final report is printed to the console.

## Architecture

```
User (topic)
  |
  v
Master Agent (claude-sonnet-4-6)
  |--- delegate_task("researcher", "Research X...")
  |      |
  |      v
  |    Researcher Agent (claude-haiku-4-5)
  |      returns findings
  |
  |--- delegate_task("writer", "Write a report using...")
  |      |
  |      v
  |    Writer Agent (claude-haiku-4-5)
  |      returns polished report
  |
  v
Final report saved to .data/reports/
```
