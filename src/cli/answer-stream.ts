/**
 * The streamed answer, written to stdout (agent-do-ftb).
 *
 * `prompt` and `script` (and the eval path) print the final answer to STDOUT so it can be piped, and with
 * `--verbose` they print it to stderr through the renderer instead. The renderer path is sanitised
 * (`writeStderr` in `src/cli/render.ts`, agent-do-9zk); stdout was not, which left a sibling of that finding open:
 * the answer is model output shaped by everything the agent read, so a hostile repository, page or MCP response
 * could put `ESC ] 52 ; c ; <base64> BEL` (clipboard write), a title rewrite, or a bidi override into it.
 *
 * THE DECISION THIS MODULE ENCODES — sanitise only when stdout is a TERMINAL.
 *
 * Unlike stderr, stdout is also a data channel: `agent-do prompt > answer.txt`, piping into another tool, and
 * `--json` consumers all receive these bytes. Rewriting them unconditionally would change the product's output
 * contract to defend a stream nobody is looking at. A terminal OBEYS control sequences; a file does not. So the
 * check is `process.stdout.isTTY`, and everything non-interactive is left byte-identical - `terminal-safety` stays
 * a defence for the human, not a transformation of the data.
 *
 * Kept in one function so the three call sites cannot drift, which is exactly how the permission-handler gap
 * (agent-do-193) arose: one write guarded, its sibling four lines below not.
 */
import { sanitiseForTerminal } from './terminal-safety.js';

/**
 * Write one chunk of streamed answer text to stdout.
 *
 * Text is neutralised only when stdout is a TTY; a piped or redirected stdout receives the bytes unchanged, so
 * consumers that parse the answer are unaffected.
 */
export function writeAnswerChunk(text: string): void {
  process.stdout.write(process.stdout.isTTY ? sanitiseForTerminal(text) : text);
}
