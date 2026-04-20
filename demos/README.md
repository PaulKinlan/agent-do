# agent-do Demos

Comprehensive demo applications showcasing agent-do in real-world scenarios. Each demo is a standalone project with its own dependencies.

## Setup

From the repo root, install the main package first:

```bash
npm install
```

Then install each demo's dependencies (using subshells so your working directory isn't changed):

```bash
(cd demos/assistant && npm install)
(cd demos/research-team && npm install)
(cd demos/code-reviewer && npm install)
```

### Choose a model provider

Each demo auto-detects which AI SDK provider to use from the environment. Set an API key for Anthropic, Google, or OpenAI:

```bash
export ANTHROPIC_API_KEY=sk-ant-...              # picks Anthropic (claude-sonnet-4-6 / claude-haiku-4-5)
export GOOGLE_GENERATIVE_AI_API_KEY=...          # picks Google    (gemini-2.5-pro   / gemini-2.5-flash)
#   …or GOOGLE_API_KEY / GEMINI_API_KEY, both accepted as aliases
export OPENAI_API_KEY=sk-...                     # picks OpenAI    (gpt-5            / gpt-5-mini)
```

If more than one is set, the demos pick **anthropic → google → openai** in that order. To force a specific provider (useful when you have multiple keys set), set `DEMO_PROVIDER`:

```bash
DEMO_PROVIDER=google npm start
```

You can also override the default model IDs for a run:

```bash
DEMO_MASTER_MODEL=claude-opus-4-6 DEMO_WORKER_MODEL=claude-sonnet-4-6 npm start
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
(cd demos/assistant && npm start)
```

### 2. Multi-Agent Research Pipeline (`demos/research-team/`)

A multi-agent orchestrator with a Master, Researcher, and Writer agent that collaborate to produce a research report.

- Master receives a topic and delegates work to specialists
- Researcher gathers information
- Writer drafts a polished report
- Real-time progress logging shows which agent is active
- Final report saved to `.data/master/reports/` (scoped under the master agent's ID)

```bash
(cd demos/research-team && npm start "Rust programming language")
```

### 3. Automated Code Reviewer (`demos/code-reviewer/`)

An agent that reads source files from a directory and produces a structured code review report.

- Takes a directory path as argument (defaults to current directory)
- Uses `FilesystemMemoryStore` in read-only mode
- Structured review covering security, bugs, and readability
- Saves review report to `.data/reviews/reviewer/` (scoped under the reviewer agent's ID)
- Progress output as files are read and analyzed

```bash
(cd demos/code-reviewer && npm start /path/to/project)
```
