---
'agent-do': patch
---

Eval CSV output is now RFC 4180 quoted: a cell containing a comma, a double quote, CR or LF is wrapped in double quotes with any inner quote doubled. Cells go through one shared `csvCell`/`csvRow` (`src/csv.ts`) from both emitters (`src/cli/eval-cmd.ts`, `src/eval/runner.ts`). The previous logic was duplicated in both and missed CR, so a lone carriage return in a case name or error message parsed as a row boundary — a forged row — and a comma shifted every later column.
