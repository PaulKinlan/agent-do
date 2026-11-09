/**
 * CLI permission handler (#17, C-01).
 *
 * The CLI used to hard-code `permissions: { mode: 'accept-all' }` on
 * every agent it built. Combined with C-02 (prompt injection via file
 * contents) and H-04 (unrestricted cwd access), that meant a hostile
 * file in the working tree could trigger `write_file` / `delete_file`
 * / `memory_write` silently.
 *
 * The new default asks before running destructive tools:
 *
 * - **Read-only tools** (`read_file`, `list_directory`, `grep_file`,
 *   `find_files`, `memory_read`, `memory_list`) auto-approve. Prompting
 *   for every file read would make the CLI unusable.
 * - **Destructive tools** prompt the operator once per exact call with
 *   "yes / no / always". An "always" answer caches the approval for that
 *   exact call (tool + arguments) for the rest of the run — not for the
 *   tool name (agent-do-ulkp: a tool-name grant turned one approved write
 *   into session-wide write immunity, including calls the operator never
 *   saw).
 * - **Non-TTY mode** (CI, shell pipes) denies destructive calls unless
 *   the operator explicitly passed `--accept-all` or listed the tool in
 *   `--allow`. Fail closed.
 * - **Explicit opt-in** via `--accept-all` skips every prompt. `--allow
 *   a,b` caches approval for specific tools up front — that stays
 *   tool-scoped because the operator (not a model-chosen call) listed it.
 */

import * as readline from 'node:readline';
import type { PermissionConfig } from '../types.js';
import { sanitiseForTerminal } from './terminal-safety.js';

/**
 * Tools that don't mutate the filesystem / memory store. Auto-approved
 * so the operator doesn't get prompted for every `read_file`. Anything
 * not in this list is treated as potentially destructive.
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'list_directory',
  'grep_file',
  'find_files',
  'memory_read',
  'memory_list',
  'memory_search',
  'memory_exists',
  'search_skills',
  'list_skills',
]);

export interface BuildPermissionsOptions {
  acceptAll: boolean;
  allow: string[];
  /** Override for tests — defaults to `process.stdin`. */
  stdin?: NodeJS.ReadStream;
  /** Override for tests — defaults to `process.stderr`. */
  stderr?: NodeJS.WriteStream;
}

/**
 * Build a PermissionConfig for the CLI. Three code paths:
 *
 * 1. `--accept-all` → classic `mode: 'accept-all'`. Nothing is prompted.
 *    The operator knows what they asked for.
 * 2. `--allow x,y` → `mode: 'ask'` with `x` and `y` listed as `'always'`
 *    in the per-tool map. The handler still prompts for everything else.
 * 3. Default → `mode: 'ask'` with a TTY-backed handler. Read-only tools
 *    are silently approved; destructive tools prompt; non-TTY fails
 *    closed.
 */
export function buildCliPermissions(
  opts: BuildPermissionsOptions,
): PermissionConfig {
  if (opts.acceptAll) {
    return { mode: 'accept-all' };
  }

  const tools: Record<string, 'always'> = {};
  for (const t of opts.allow) tools[t] = 'always';

  const stdin = opts.stdin ?? process.stdin;
  const stderr = opts.stderr ?? process.stderr;
  const sessionApproved = new Set<string>();

  const onPermissionRequest = async (req: {
    toolName: string;
    args: unknown;
  }): Promise<boolean> => {
    if (READ_ONLY_TOOLS.has(req.toolName)) return true;
    const key = approvalKey(req.toolName, req.args);
    if (sessionApproved.has(key)) return true;

    // Both sides must be a TTY. Codex #68 P2: if only stdin is a TTY
    // but stderr is redirected (e.g. `2>agent.log`), the prompt text
    // goes to the log file — the operator sees the agent "hang" at
    // the question and has no idea what to do. Fail closed in that
    // case and tell them to use `--accept-all` / `--allow`.
    if (!stdin.isTTY || !stderr.isTTY) {
      // `toolName` is chosen by the model, and this is the line that asks a human to authorise it - so it
      // is exactly the text an attacker would want to dress up (agent-do-9zk).
      stderr.write(
        sanitiseForTerminal(
          `\n[agent-do] Denying destructive call ${req.toolName} — non-interactive session ` +
            `(stdin ${stdin.isTTY ? 'OK' : 'not a TTY'}, stderr ${stderr.isTTY ? 'OK' : 'not a TTY'}). ` +
            `Pass --accept-all or --allow ${req.toolName} to auto-approve.\n`,
        ),
      );
      return false;
    }

    const argsPreview = previewArgs(req.args);
    const rl = readline.createInterface({ input: stdin, output: stderr });
    try {
      const answer: string = await new Promise((resolve) => {
        // The prompt itself, not just the non-TTY denial above. Both the tool name and the argument preview
        // are model-chosen - readline writes this straight to the TTY, so an attacker-supplied tool name or
        // argument could rewrite the line the human is about to answer (agent-do-193). Guarding one of the two
        // writes in this file and not the other is exactly how that finding arose.
        rl.question(
          sanitiseForTerminal(
            `\n[agent-do] Agent wants to call ${req.toolName}(${argsPreview}).\n` +
              `           Allow? [y]es / [n]o / [a]lways (this exact call, this session): `,
          ),
          resolve,
        );
      });
      const trimmed = answer.trim().toLowerCase();
      if (trimmed.startsWith('a')) {
        sessionApproved.add(key);
        return true;
      }
      return trimmed.startsWith('y');
    } finally {
      rl.close();
    }
  };

  return {
    mode: 'ask',
    tools: Object.keys(tools).length > 0 ? tools : undefined,
    onPermissionRequest,
  };
}

/** Per-value rendered length budget before a value collapses to head+tail. */
const PREVIEW_VALUE_MAX = 160;
/** Head kept when a long value collapses. */
const PREVIEW_HEAD = 80;
/** Tail kept when a long value collapses — the END of a path/value is often where the decision lives. */
const PREVIEW_TAIL = 40;

/**
 * One-line preview of the tool args for the prompt.
 *
 * Two constraints shape it:
 *
 * - Copilot #68: never JSON.stringify a full payload (a 1 MB content arg
 *   allocated ~1 MB to show 117 bytes). Each leaf is rendered directly,
 *   bounded by its own budget — work is proportional to the number of
 *   leaves, not to any value's size.
 * - agent-do-ulkp: the operator authorises what they can SEE. The old
 *   120-char overall cap truncated the preview mid-call, hiding the
 *   decision-relevant part of a long path and dropping later keys
 *   entirely. Every key is now always present, and a long value
 *   collapses to head + `[N chars]` + tail instead of head-only, so
 *   neither end of a value is hidden.
 */
function previewArgs(args: unknown): string {
  if (args === undefined || args === null) return '';
  return renderValue(args);
}

function renderValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    if (value.length <= PREVIEW_VALUE_MAX) return JSON.stringify(value);
    const head = value.slice(0, PREVIEW_HEAD);
    const tail = value.slice(-PREVIEW_TAIL);
    return JSON.stringify(`${head}…[${value.length} chars]…${tail}`);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, 5).map(renderValue);
    if (value.length > 5) items.push(`…+${value.length - 5} more`);
    return `[${items.join(', ')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${JSON.stringify(k)}: ${renderValue(v)}`,
    );
    return `{${entries.join(', ')}}`;
  }
  return String(value);
}

/**
 * Identity of one tool invocation: the tool name plus a canonical
 * (key-sorted) JSON of its arguments. "always" grants THIS call, so two
 * calls with the same arguments in a different key order are the same
 * grant, and a call that differs anywhere re-prompts. The full canonical
 * form is required — a head/tail preview key could collide two calls
 * whose difference hides in the middle.
 */
function approvalKey(toolName: string, args: unknown): string {
  const sortValue = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortValue);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, val]) => [k, sortValue(val)]),
      );
    }
    return v;
  };
  let canonical: string;
  try {
    canonical = JSON.stringify(sortValue(args));
  } catch {
    canonical = String(args);
  }
  return `${toolName} ${canonical}`;
}

export { READ_ONLY_TOOLS };
