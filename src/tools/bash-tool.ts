/**
 * `bash` tool — run shell commands through a {@link SandboxApi}.
 *
 * The tool is intentionally **sandbox-required**: a real shell with the
 * same privileges as the Node.js process is the wrong default for an
 * LLM-controlled tool, so `createBashTool(undefined)` throws. To opt
 * into native shell anyway, pass `createNoopSandbox()` explicitly —
 * making the unsafe choice a deliberate, named one.
 *
 * Output is bounded to a UTF-8 byte cap on each stream. Connectors are
 * expected to honour `timeout` (in milliseconds); if the connector
 * doesn't, the tool falls back to a hard wall-clock cap of 60s.
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
} from './content-guards.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const s = (schema: z.ZodType): any => schema;

export interface CreateBashToolOptions {
  /** Default working directory passed to `sandbox.exec`. */
  cwd?: string;
  /**
   * Default timeout in milliseconds. The model can override per call up
   * to {@link maxTimeoutMs}.
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
   * Override the tool's name. Default `bash`. Useful if you want to
   * mount more than one shell tool against different sandboxes.
   */
  name?: string;
  /**
   * Override the tool's description shown to the model. Default
   * mentions sandbox isolation and the lack of stdin support.
   */
  description?: string;
}

export function createBashTool(
  sandbox: SandboxApi | undefined,
  options: CreateBashToolOptions = {},
): ToolSet {
  if (!sandbox) {
    throw new Error(
      'createBashTool requires a SandboxApi. Pass `createNoopSandbox()` to ' +
        'opt into a real host shell explicitly, or use one of the isolating ' +
        'connectors (createJustBashSandbox, createSandboxRuntimeSandbox, ' +
        'createVercelSandbox).',
    );
  }

  const toolName = options.name ?? 'bash';
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  const maxTimeoutMs = options.maxTimeoutMs ?? 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_READ_BYTES;
  const description =
    options.description ??
    'Run a shell command in the configured sandbox. ' +
      'Returns stdout, stderr, and exit code. ' +
      'Sandboxed: filesystem and network are restricted by the connector. ' +
      'No stdin support — use `<<EOF` heredocs or input files. ' +
      'Time out after a configured wall-clock cap.';

  const bash = tool({
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
            'Per-call timeout in milliseconds. Capped at the tool default.',
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
        result = await sandbox.exec(command, {
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
      const modelContent = renderForModel(stdout, stderr, result.exitCode);
      const summary =
        `[${toolName}] exit=${result.exitCode}, ` +
        `${utf8ByteLength(result.stdout)}B stdout, ` +
        `${utf8ByteLength(result.stderr)}B stderr, ${durationMs}ms`;
      return {
        modelContent,
        userSummary: summary,
        data: {
          command,
          cwd: cwd ?? options.cwd,
          exitCode: result.exitCode,
          stdoutBytes: utf8ByteLength(result.stdout),
          stderrBytes: utf8ByteLength(result.stderr),
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          durationMs,
        },
      };
    },
  });

  return { [toolName]: bash };
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
