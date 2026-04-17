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
 * - **Destructive tools** prompt the operator once per (tool, session)
 *   with "yes / no / always". An "always" answer caches the approval
 *   for the rest of the run.
 * - **Non-TTY mode** (CI, shell pipes) denies destructive calls unless
 *   the operator explicitly passed `--accept-all` or listed the tool in
 *   `--allow`. Fail closed.
 * - **Explicit opt-in** via `--accept-all` skips every prompt. `--allow
 *   a,b` caches approval for specific tools up front.
 */

import * as readline from 'node:readline';
import type { PermissionConfig } from '../types.js';

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
    if (sessionApproved.has(req.toolName)) return true;

    // Both sides must be a TTY. Codex #68 P2: if only stdin is a TTY
    // but stderr is redirected (e.g. `2>agent.log`), the prompt text
    // goes to the log file — the operator sees the agent "hang" at
    // the question and has no idea what to do. Fail closed in that
    // case and tell them to use `--accept-all` / `--allow`.
    if (!stdin.isTTY || !stderr.isTTY) {
      stderr.write(
        `\n[agent-do] Denying destructive call ${req.toolName} — non-interactive session ` +
        `(stdin ${stdin.isTTY ? 'OK' : 'not a TTY'}, stderr ${stderr.isTTY ? 'OK' : 'not a TTY'}). ` +
        `Pass --accept-all or --allow ${req.toolName} to auto-approve.\n`,
      );
      return false;
    }

    const argsPreview = previewArgs(req.args);
    const rl = readline.createInterface({ input: stdin, output: stderr });
    try {
      const answer: string = await new Promise((resolve) => {
        rl.question(
          `\n[agent-do] Agent wants to call ${req.toolName}(${argsPreview}).\n` +
          `           Allow? [y]es / [n]o / [a]lways (this session): `,
          resolve,
        );
      });
      const trimmed = answer.trim().toLowerCase();
      if (trimmed.startsWith('a')) {
        sessionApproved.add(req.toolName);
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

/** Maximum length of any single string value inside the args preview. */
const PREVIEW_VALUE_MAX = 80;
/** Overall cap on the rendered preview string. */
const PREVIEW_MAX = 120;

/**
 * One-line preview of the tool args for the prompt. Per Copilot #68:
 * the earlier implementation called `JSON.stringify(args)` on the full
 * payload and only truncated afterwards, which for a `write_file`
 * content argument near the 1 MB cap meant allocating ~1 MB of JSON
 * just to slice off 117 bytes of it.
 *
 * The new approach pre-truncates each string leaf to `PREVIEW_VALUE_MAX`
 * before serialising, and caps the final string at `PREVIEW_MAX`. Work
 * is bounded by the number of keys in the args object, not by the size
 * of any single value.
 */
function previewArgs(args: unknown): string {
  if (args === undefined || args === null) return '';
  let text: string;
  try {
    text = JSON.stringify(args, (_key, value) => {
      if (typeof value === 'string' && value.length > PREVIEW_VALUE_MAX) {
        return value.slice(0, PREVIEW_VALUE_MAX - 3) + '...';
      }
      return value;
    });
  } catch {
    text = String(args);
  }
  if (text.length > PREVIEW_MAX) text = text.slice(0, PREVIEW_MAX - 3) + '...';
  return text;
}

export { READ_ONLY_TOOLS };
