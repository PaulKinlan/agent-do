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

The streamed answer on stdout is covered too, and only when stdout is a terminal
(`src/cli/answer-stream.ts`): a terminal obeys control sequences, a file or pipe does not. Redirected and piped
output stays byte-identical, so consumers that parse the answer are unaffected.

Interactive mode's answer and a scheduled task's answer are covered too — both are separate streaming loops that
assign the model output to a local before printing it, which is why a check that looked for `stdout.write(event.*)`
could not see them (agent-do-wcq).

The saved-agent listings and the scheduled-task listings are covered too, and the invariant that keeps stdout writes
honest now examines `console.log`/`info`/`debug` as well as `process.stdout.write` (agent-do-bc4). A line written
directly to stdout must be a literal, a template whose every interpolation is sanitised, a machine format
(JSON/CSV/crontab), or go through the sanitising seam; `printable`, the listing renderer, now shares the unsafe
character set with the sanitiser and therefore also neutralises bidi overrides.
