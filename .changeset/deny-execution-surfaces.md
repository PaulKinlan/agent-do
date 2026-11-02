---
'agent-do': patch
---

The default write deny list now covers execution-surface config: `.github/workflows/**`, `.vscode/**`, `.devcontainer/**`, `.claude/**`, `.cursor/**` and `.mcp.json` (matched at any depth, gitignore-style). A file-writing agent could previously hand itself persistence by writing CI workflows (which run with repo secrets), editor tasks / devcontainer lifecycle commands (which run on the next build), agent hooks, or MCP server definitions (which launch arbitrary commands). Reads of those paths stay allowed — the risk is mutation, not disclosure — and `--include-sensitive` remains the explicit operator opt-out (agent-do-x6v6).
