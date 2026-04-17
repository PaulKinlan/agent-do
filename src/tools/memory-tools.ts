/**
 * Memory tools — the agent's private scratchpad.
 *
 * Like workspace tools, memory tools return structured {@link ToolResult}s
 * so the model gets sanitised, bounded content while the operator gets
 * rich summaries. The model is told (via the system prompt) that
 * anything inside `<tool_output>` markers is data, not instructions.
 *
 * Tools are prefixed `memory_*` so the agent clearly distinguishes its
 * own scratchpad from the project workspace.
 */

import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import type { MemoryStore } from '../stores.js';
import type { ToolResult } from './types.js';
import {
  DEFAULT_MAX_READ_BYTES,
  DEFAULT_MAX_WRITE_BYTES,
  sanitiseFsError,
  utf8ByteLength,
  wrapForModel,
} from './content-guards.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const s = (schema: z.ZodType): any => schema;

export interface MemoryToolsOptions {
  maxReadBytes?: number;
  maxWriteBytes?: number;
}

function errorResult(err: unknown, op: string, relPath: string): ToolResult {
  const sanitised = sanitiseFsError(err, op, relPath);
  return {
    modelContent: sanitised.modelContent,
    userSummary: sanitised.userSummary,
    data: {
      op,
      path: relPath,
      code: sanitised.code,
      rawMessage: sanitised.rawMessage,
      error: true,
    },
  };
}

/**
 * Create memory-scoped tools backed by a MemoryStore.
 *
 * Emits `memory_read`, `memory_write`, `memory_list`, `memory_delete`,
 * and `memory_search`. All operations are scoped to the given agentId.
 */
export function createMemoryTools(
  store: MemoryStore,
  agentId: string,
  options: MemoryToolsOptions = {},
): ToolSet {
  const maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const maxWriteBytes = options.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES;

  return {
    memory_read: tool({
      description:
        "Read a file from the agent's private memory. Use this to recall notes, plans, or facts you wrote in a previous turn or session. Content is wrapped in <tool_output> markers.",
      inputSchema: s(
        z.object({
          path: z.string().describe('Path within memory (e.g. "notes.md")'),
        }),
      ),
      execute: async ({ path }: { path: string }): Promise<ToolResult> => {
        try {
          const body = await store.read(agentId, path);
          const wrapped = wrapForModel(body, {
            tool: 'memory_read',
            path,
            maxBytes: maxReadBytes,
          });
          const lines = body.split('\n').length;
          return {
            modelContent: wrapped.content,
            userSummary: `[memory_read] ${path} — ${wrapped.totalBytes} bytes${wrapped.truncated ? ' (truncated)' : ''}`,
            data: {
              path,
              bytes: wrapped.totalBytes,
              lines,
              truncated: wrapped.truncated,
              redactedMarkerCount: wrapped.redactedMarkerCount,
            },
          };
        } catch (err) {
          return errorResult(err, 'memory_read', path);
        }
      },
    }),

    memory_write: tool({
      description:
        "Write to a file in the agent's private memory. Use this to save notes, plans, or facts you want to remember in future turns or sessions. Does not affect the user's project files.",
      inputSchema: s(
        z.object({
          path: z.string().describe('Path within memory (e.g. "notes.md")'),
          content: z.string().describe('The content to write'),
        }),
      ),
      execute: async ({
        path,
        content,
      }: {
        path: string;
        content: string;
      }): Promise<ToolResult> => {
        const bytes = utf8ByteLength(content);
        if (bytes > maxWriteBytes) {
          return {
            modelContent: `Refused: content is ${bytes} bytes, limit is ${maxWriteBytes}.`,
            userSummary: `[memory_write] ${path} — REFUSED (${bytes} > ${maxWriteBytes} bytes)`,
            data: { path, bytes, limit: maxWriteBytes, blocked: true, reason: 'write-size-limit' },
            blocked: true,
          };
        }
        try {
          await store.write(agentId, path, content);
          return {
            modelContent: `Wrote ${bytes} bytes to memory: ${path}`,
            userSummary: `[memory_write] ${path} — ${bytes} bytes`,
            data: { path, bytes },
          };
        } catch (err) {
          return errorResult(err, 'memory_write', path);
        }
      },
    }),

    memory_list: tool({
      description: "List files in the agent's private memory.",
      inputSchema: s(
        z.object({
          path: z
            .string()
            .optional()
            .describe('Subdirectory within memory (defaults to root)'),
        }),
      ),
      execute: async ({ path }: { path?: string }): Promise<ToolResult> => {
        const listPath = path ?? '.';
        try {
          const entries = await store.list(agentId, path);
          if (entries.length === 0) {
            return {
              modelContent: 'Memory is empty.',
              userSummary: `[memory_list] ${listPath} — empty`,
              data: { path: listPath, count: 0 },
            };
          }
          const rendered = entries
            .map((e) => `${e.type === 'directory' ? '[dir]' : '[file]'} ${e.name}`)
            .join('\n');
          return {
            modelContent: rendered,
            userSummary: `[memory_list] ${listPath} — ${entries.length} entries`,
            data: { path: listPath, count: entries.length },
          };
        } catch (err) {
          return errorResult(err, 'memory_list', listPath);
        }
      },
    }),

    memory_delete: tool({
      description: "Delete a file from the agent's private memory.",
      inputSchema: s(
        z.object({
          path: z.string().describe('Path within memory'),
        }),
      ),
      execute: async ({ path }: { path: string }): Promise<ToolResult> => {
        try {
          await store.delete(agentId, path);
          return {
            modelContent: `Deleted from memory: ${path}`,
            userSummary: `[memory_delete] ${path}`,
            data: { path },
          };
        } catch (err) {
          return errorResult(err, 'memory_delete', path);
        }
      },
    }),

    memory_search: tool({
      description:
        "Search the agent's private memory for a pattern. Literal " +
        'substring (case-insensitive) by default. Pass `regex: true` to ' +
        'treat the pattern as a regex — the same safety checks apply as ' +
        'for grep_file (length cap + catastrophic-backtracking guard).',
      inputSchema: s(
        z.object({
          pattern: z
            .string()
            .describe('Text pattern to search for. Literal substring by default.'),
          path: z
            .string()
            .optional()
            .describe('Subdirectory to search within (defaults to root)'),
          regex: z
            .boolean()
            .optional()
            .describe('Treat pattern as a regex (opt-in; safety-checked)'),
        }),
      ),
      execute: async ({
        pattern,
        path,
        regex,
      }: {
        pattern: string;
        path?: string;
        regex?: boolean;
      }): Promise<ToolResult> => {
        const scope = path ?? '.';
        try {
          const results = await store.search(agentId, pattern, path, { regex });
          if (results.length === 0) {
            return {
              modelContent: `No matches found for "${pattern}"`,
              userSummary: `[memory_search] "${pattern}" under ${scope} — 0 matches`,
              data: { pattern, scope, matchCount: 0 },
            };
          }
          const fileSet = new Set(results.map((r) => r.path));
          return {
            modelContent: results.map((r) => `${r.path}: ${r.line}`).join('\n'),
            userSummary: `[memory_search] "${pattern}" under ${scope} — ${results.length} match${results.length === 1 ? '' : 'es'} in ${fileSet.size} file${fileSet.size === 1 ? '' : 's'}`,
            data: { pattern, scope, matchCount: results.length, fileCount: fileSet.size },
          };
        } catch (err) {
          return errorResult(err, 'memory_search', scope);
        }
      },
    }),
  };
}
