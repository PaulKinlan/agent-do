# agent-do Demos

Comprehensive demo applications showcasing agent-do in real-world scenarios. Each demo is a workspace member of the repository (npm workspaces), so the five of them share **one** install and **one** lockfile at the repo root.

## Setup

Everything installs from the repo root — there is no per-demo install, and no per-demo `package-lock.json`:

```bash
npm install
```

That one command installs the library, the workspace links for all five demos, and their dependencies (which are hoisted to the root `node_modules`).

### Choose a model provider

Each demo auto-detects which AI SDK provider to use from the environment. Set an API key for Anthropic, Google, or OpenAI:

```bash
export ANTHROPIC_API_KEY=sk-ant-...              # picks Anthropic (claude-opus-5           / claude-haiku-4-5)
export GOOGLE_GENERATIVE_AI_API_KEY=...          # picks Google    (gemini-3.6-flash        / gemini-3.5-flash-lite)
#   …or GOOGLE_API_KEY / GEMINI_API_KEY, both accepted as aliases
export OPENAI_API_KEY=sk-...                     # picks OpenAI    (gpt-5.6-terra           / gpt-5.6-luna)
```

If more than one is set, the demos pick **anthropic → google → openai** in that order. To force a specific provider (useful when you have multiple keys set), set `DEMO_PROVIDER`:

```bash
DEMO_PROVIDER=google npm start
```

You can also override the default model IDs for a run:

```bash
DEMO_MASTER_MODEL=claude-opus-5 DEMO_WORKER_MODEL=claude-sonnet-5 npm start
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
- Final report saved to `.data/reports/`

```bash
(cd demos/research-team && npm start "Rust programming language")
```

### 3. Automated Code Reviewer (`demos/code-reviewer/`)

An agent that reads source files from a directory and produces a structured code review report.

- Takes a directory path as argument (defaults to current directory)
- Mounts the review target read-only via `createWorkspaceTools(dir, { readOnly: true })`
- Structured review covering security, bugs, and readability
- Saves review report to `.data/reviews/`
- Progress output as files are read and analyzed

```bash
(cd demos/code-reviewer && npm start /path/to/project)
```

### 4. Chief of Staff (`demos/chief-of-staff/`)

Founder's chief-of-staff pattern built on the orchestrator. A master agent coordinates three specialists — Executive Assistant, Business Development, Task Manager — against a shared workspace of markdown files.

- **Policy-as-markdown**: `priority-map.md` + `auto-resolver.md` are re-read at the start of every run and ground every decision
- **Source-of-truth rule**: specialists always check the current state of `inbox.md` / `tracker.md` / `tasks.md` before acting
- **Silence contract**: if there's nothing to do, the master returns `OK` and calls no tools — cheap to run on a cron
- **Role-handoff pattern**: each specialist has a narrow brief and defers to the others

```bash
(cd demos/chief-of-staff && npm start "Triage the inbox and add follow-ups to tasks.md")
```

### 5. Engineering Team (`demos/engineering-team/`)

Sprint-ordered planning pipeline. A master runs five phases in order — Think → Plan → Review → Test → Ship — each handed off to a specialist that produces a written artifact the next phase consumes.

- **Sprint-ordered pipeline**: each phase strictly follows the previous
- **Specialist role prompts**: opinionated stances baked into each system prompt
- **Forcing questions as scaffolding**: office-hours interrogates rather than designs
- **Shared workspace**: every artifact lives in `./sprint/` so phases can reference each other

```bash
(cd demos/engineering-team && npm start "Add an audit log for write operations")
```
