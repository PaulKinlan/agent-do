# agent-do Demos

Comprehensive demo applications showcasing agent-do in real-world scenarios. Each demo is a standalone project with its own dependencies.

## Setup

From the repo root, install the main package first:

```bash
npm install
```

Then install each demo's dependencies:

```bash
cd demos/assistant && npm install
cd demos/research-team && npm install
cd demos/code-reviewer && npm install
```

Make sure your `ANTHROPIC_API_KEY` environment variable is set:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## Demos

### 1. Interactive CLI Assistant (`demos/assistant/`)

A multi-turn interactive assistant with persistent file storage, streaming output, lifecycle hooks, and session-level usage tracking.

- Persistent memory via `FilesystemMemoryStore` (stored in `.data/`)
- Conversation history across messages
- File tools for read/write/search/list
- Streaming mode shows tool calls as they happen
- Lifecycle hooks log usage and cost after each run
- Session summary on exit (total tokens, cost, messages)

```bash
cd demos/assistant && npm start
```

### 2. Multi-Agent Research Pipeline (`demos/research-team/`)

A multi-agent orchestrator with a Master, Researcher, and Writer agent that collaborate to produce a research report.

- Master receives a topic and delegates work to specialists
- Researcher gathers information
- Writer drafts a polished report
- Real-time progress logging shows which agent is active
- Final report saved to `.data/reports/`

```bash
cd demos/research-team && npm start "Rust programming language"
```

### 3. Automated Code Reviewer (`demos/code-reviewer/`)

An agent that reads source files from a directory and produces a structured code review report.

- Takes a directory path as argument (defaults to current directory)
- Uses `FilesystemMemoryStore` in read-only mode
- Structured review covering security, bugs, and readability
- Saves review report to `.data/reviews/`
- Progress output as files are read and analyzed

```bash
cd demos/code-reviewer && npm start /path/to/project
```
