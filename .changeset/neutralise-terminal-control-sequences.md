---
'agent-do': patch
---

Neutralise terminal control sequences in CLI output. Tool-derived text — tool-result summaries, the `data`
preview, `--show-content` bodies, tool arguments, model thinking, the debug/trace message dumps, scheduled-task run errors and the permission-denial notice — is written to
stderr through one `writeStderr` helper that replaces C0/C1 controls (except newline and tab) and bidi overrides
with visible `[U+XXXX]` markers. An attacker-influenced file, page or MCP response could previously rewrite the
operator's window title, put text on their clipboard (OSC 52), erase or overwrite already-printed lines, or use a
bidi override to display a different path from the one printed.

The interactive approval prompt is covered too (`rl.question` prints the model-chosen tool name and argument
preview straight to the TTY); the non-TTY denial notice and the prompt now share the sanitiser, which is how the
gap between them closed.
