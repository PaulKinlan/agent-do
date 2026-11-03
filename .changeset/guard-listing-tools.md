---
'agent-do': patch
---

`find_files` and `list_directory` output now goes through the same tool-result guarding as `read_file` and `grep_file`: the listing is wrapped in the `<tool_output>` boundary frame, prompt-injection markers in entry names are redacted (with the count reported in `data`), and the rendered text is size-capped at `maxReadBytes` with a truncation marker — so a huge tree can no longer blow the model context and injection-bait filenames can no longer reach the model as raw text. `data.entries` stays complete so deny-list filtering still sees every entry. The deny-filtered re-render path carries the same frame (it previously silently dropped it).
