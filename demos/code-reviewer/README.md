# Automated Code Reviewer

An agent that reads source files from a directory and produces a structured code review report covering security, bugs, readability, and best practices.

## What it does

- **Directory scanning** -- Reads all source files from the target directory.
- **Read-only mode** -- Uses `FilesystemMemoryStore` with `readOnly: true` so the agent cannot modify your code.
- **Structured review** -- Produces a report organized by severity (critical, warning, suggestion).
- **File output** -- Saves the review report to `.data/reviews/reviewer/` as a markdown file (scoped under the reviewer agent's ID by `FilesystemMemoryStore`).
- **Progress logging** -- Shows which files are being read and analyzed.

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

# Review a specific directory
npm start /path/to/your/project

# Review the current directory (default)
npm start
```

This demo auto-detects the provider from whichever API key is set. To force a specific provider when multiple keys are present, set `DEMO_PROVIDER=anthropic|google|openai`. See [demos/README.md](../README.md#choose-a-model-provider) for the full env surface.

## What to expect

1. The agent scans the target directory structure.
2. Progress output shows files being read.
3. The agent analyzes code for:
   - Security vulnerabilities (injection, auth issues, secrets)
   - Bugs and logic errors
   - Code readability and maintainability
   - Best practices and patterns
4. A structured review report is saved to `.data/reviews/reviewer/review-TIMESTAMP.md`.
5. The report summary is printed to the console.

## Example output

```
Reading project structure...
  [tool-call] find_files({ path: "." })
  [tool-call] read_file({ path: "src/index.ts" })
  [tool-call] read_file({ path: "src/auth.ts" })

Analyzing code...

Review saved to .data/reviews/reviewer/review-2025-01-15T10-30-00.md

Summary:
  Files reviewed: 5
  Critical issues: 1
  Warnings: 3
  Suggestions: 7
```
