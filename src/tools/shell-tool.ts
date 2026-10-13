/**
 * Shell tool — surface `SandboxApi.exec` as a single tool the model
 * can invoke (default name: `bash`).
 *
 * If you're looking for structured per-op file tools (read_file,
 * write_file, …) instead of (or in addition to) a shell, see
 * `createWorkspaceTools`. This factory creates exactly one tool
 * whose `execute` runs `sandbox.exec(...)`.
 *
 * When `sandbox` is supplied, that connector is what runs the commands.
 * There is no implicit fallback: host execution is **not** a security
 * boundary, so it has to be asked for by passing
 * `createHostSandbox()` explicitly. Calling `createShellTool()` with no
 * sandbox throws rather than silently giving the model the host shell.
 * For any task that touches untrusted input, pass an isolating connector
 * (`createJustBashSandbox`, or your own).
 *
 * Output is wrapped in `<tool_output tool="…" command="…">` markers with
 * the same prompt-injection-marker redaction `read_file` and `memory_read`
 * apply — shell stdout/stderr is attacker-controlled text (a fetched
 * page, a log line, a filename) and reaches the model through the same
 * trust boundary as any other tool output. Output is bounded to a UTF-8
 * byte cap on each stream. Per-call timeouts are forwarded to
 * `sandbox.exec` — connectors are expected to honour them. The tool
 * itself doesn't enforce a wall-clock cap on top, since racing a timer
 * would leak the underlying process; if your connector ignores `timeout`,
 * fix it there.
 */

import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import type { SandboxApi } from '../sandbox/types.js';
import type { ToolResult } from './types.js';
import {
  DEFAULT_MAX_READ_BYTES,
  truncateUtf8ByBytes,
  utf8ByteLength,
  wrapForModel,
} from './content-guards.js';

/**
 * Cap on the `command` attribute echoed inside the `<tool_output>`
 * marker. The command is already visible to the model (it wrote it) and
 * may be long; this just stops a heredoc-sized command from bloating
 * the marker.
 */
const MAX_COMMAND_ATTR_CHARS = 200;

/**
 * Slack added on top of the two per-stream caps when sizing the whole
 * framed body, so the per-stream `…[truncated]` markers stay the only
 * truncation a caller sees.
 */
const FRAMED_BODY_SLACK_BYTES = 4 * 1024;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const s = (schema: z.ZodType): any => schema;

export interface CreateShellToolOptions {
  /** Default working directory passed to `sandbox.exec`. */
  cwd?: string;
  /**
   * Default timeout in milliseconds. The model can override per call up
   * to {@link CreateShellToolOptions.maxTimeoutMs}.
   */
  defaultTimeoutMs?: number;
  /**
   * Hard cap on per-call timeout. The tool refuses values above this.
   * Default: 60_000ms.
   */
  maxTimeoutMs?: number;
  /**
   * Cap on bytes returned to the model from each of stdout/stderr.
   * Default mirrors `read_file`'s cap.
   */
  maxOutputBytes?: number;
  /**
   * Override the tool's name. Default `bash` (so the model picks up
   * familiar shell conventions). Useful if you want to mount more
   * than one shell tool against different sandboxes — e.g. one named
   * `host_shell` and another `vm_shell`.
   */
  name?: string;
  /**
   * Override the tool's description shown to the model. Default
   * mentions sandbox isolation and the lack of stdin support.
   */
  description?: string;
}

export function createShellTool(
  sandbox: SandboxApi,
  options: CreateShellToolOptions = {},
): ToolSet {
  // Runtime guard for JS consumers (and for a TS `any`/`undefined` that
  // gets past the compiler): never hand the model the host shell by
  // accident.
  if (!sandbox) {
    throw new Error(
      'createShellTool() requires a sandbox. Pass an isolating connector ' +
        '(e.g. `await createJustBashSandbox()`), or pass ' +
        '`createHostSandbox()` explicitly to run commands directly on the ' +
        'host — host execution is not a security boundary, so it is never ' +
        'enabled implicitly.',
    );
  }
  const target = sandbox;

  const toolName = options.name ?? 'bash';
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  const maxTimeoutMs = options.maxTimeoutMs ?? 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_READ_BYTES;
  const description =
    options.description ??
    'Run a shell command in the configured sandbox. ' +
      'Returns stdout, stderr, and exit code inside <tool_output> markers. ' +
      'Filesystem and network access are scoped to whatever the connector allows. ' +
      'No stdin support — use `<<EOF` heredocs or input files.';

  const shell = tool({
    description,
    inputSchema: s(
      z.object({
        command: z.string().min(1).describe('The shell command to run.'),
        cwd: z
          .string()
          .optional()
          .describe('Working directory inside the sandbox (optional).'),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Per-call timeout in milliseconds. Capped at the tool's maxTimeoutMs (default ${maxTimeoutMs}ms); ` +
              `defaults to ${defaultTimeoutMs}ms when omitted.`,
          ),
      }),
    ),
    execute: async ({
      command,
      cwd,
      timeoutMs,
    }: {
      command: string;
      cwd?: string;
      timeoutMs?: number;
    }): Promise<ToolResult> => {
      const requested = timeoutMs ?? defaultTimeoutMs;
      if (requested > maxTimeoutMs) {
        return {
          modelContent: `Refused: timeout ${requested}ms exceeds limit ${maxTimeoutMs}ms.`,
          userSummary: `[${toolName}] REFUSED — timeout ${requested}ms > cap ${maxTimeoutMs}ms`,
          data: { blocked: true, reason: 'timeout-too-large', limit: maxTimeoutMs },
          blocked: true,
        };
      }
      const startedAt = Date.now();
      let result;
      try {
        result = await target.exec(command, {
          cwd: cwd ?? options.cwd,
          timeout: requested,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          modelContent: `Error running command: ${message}`,
          userSummary: `[${toolName}] threw — ${message}`,
          data: { command, error: true, message },
        };
      }
      const durationMs = Date.now() - startedAt;
      const stdout = capUtf8(result.stdout, maxOutputBytes);
      const stderr = capUtf8(result.stderr, maxOutputBytes);
      const framed = wrapForModel(
        renderForModel(stdout, stderr, result.exitCode),
        {
          tool: toolName,
          command: summarizeCommand(command),
          // Per-stream caps above already bound the body; this is a
          // backstop that should not fire in practice.
          maxBytes: maxOutputBytes * 2 + FRAMED_BODY_SLACK_BYTES,
        },
      );
      const markerNote =
        framed.redactedMarkerCount > 0
          ? `, redacted ${framed.redactedMarkerCount} potential injection marker${framed.redactedMarkerCount === 1 ? '' : 's'}`
          : '';
      const summary =
        `[${toolName}] exit=${result.exitCode}, ` +
        `${utf8ByteLength(result.stdout)}B stdout, ` +
        `${utf8ByteLength(result.stderr)}B stderr, ${durationMs}ms${markerNote}`;
      return {
        modelContent: framed.content,
        userSummary: summary,
        data: {
          command,
          cwd: cwd ?? options.cwd,
          exitCode: result.exitCode,
          stdoutBytes: utf8ByteLength(result.stdout),
          stderrBytes: utf8ByteLength(result.stderr),
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          redactedMarkerCount: framed.redactedMarkerCount,
          durationMs,
        },
      };
    },
  });

  return { [toolName]: shell };
}

interface Capped { content: string; truncated: boolean; }

function capUtf8(text: string, cap: number): Capped {
  if (utf8ByteLength(text) <= cap) {
    return { content: text, truncated: false };
  }
  const ellipsis = '\n…[truncated]';
  const budget = Math.max(0, cap - utf8ByteLength(ellipsis));
  return { content: truncateUtf8ByBytes(text, budget) + ellipsis, truncated: true };
}

function renderForModel(stdout: Capped, stderr: Capped, exitCode: number): string {
  const parts: string[] = [];
  parts.push(`exit_code: ${exitCode}`);
  parts.push('stdout:');
  parts.push(stdout.content || '(empty)');
  parts.push('stderr:');
  parts.push(stderr.content || '(empty)');
  return parts.join('\n');
}

/**
 * One-line, length-capped form of the command for the marker attribute.
 * Collapsing newlines keeps the attribute readable for multi-line
 * commands (heredocs, `&&` chains) without changing what ran.
 */
function summarizeCommand(command: string): string {
  const oneLine = command.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_COMMAND_ATTR_CHARS
    ? `${oneLine.slice(0, MAX_COMMAND_ATTR_CHARS - 1)}…`
    : oneLine;
}
