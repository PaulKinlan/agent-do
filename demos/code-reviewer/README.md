# Automated Code Reviewer

An agent that reads source files from a directory and produces a structured code review report covering security, bugs, readability, and best practices.

## What it does

- **Directory scanning** -- Reads all source files from the target directory.
- **Read-only mode** -- Uses `FilesystemMemoryStore` with `readOnly: true` so the agent cannot modify your code.
- **Structured review** -- Produces a report organized by severity (critical, warning, suggestion).
- **File output** -- Saves the review report to `.data/reviews/` as a markdown file.
- **Progress logging** -- Shows which files are being read and analyzed.

## How to run

```bash
# Install dependencies
npm install

# Set your API key
export ANTHROPIC_API_KEY=sk-ant-...

# Review a specific directory
npm start /path/to/your/project

# Review the current directory (default)
npm start
```

## What to expect

1. The agent scans the target directory structure.
2. Progress output shows files being read.
3. The agent analyzes code for:
   - Security vulnerabilities (injection, auth issues, secrets)
   - Bugs and logic errors
   - Code readability and maintainability
   - Best practices and patterns
4. A structured review report is saved to `.data/reviews/review-TIMESTAMP.md`.
5. The report summary is printed to the console.

## Example output

```
Reading project structure...
  [tool-call] find_files({ path: "." })
  [tool-call] read_file({ path: "src/index.ts" })
  [tool-call] read_file({ path: "src/auth.ts" })

Analyzing code...

Review saved to .data/reviews/review-2025-01-15T10-30-00.md

Summary:
  Files reviewed: 5
  Critical issues: 1
  Warnings: 3
  Suggestions: 7
```
