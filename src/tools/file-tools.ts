/**
 * File tools backed by any MemoryStore implementation.
 *
 * Each tool returns a {@link ToolResult} so the model sees a short, sanitised
 * `modelContent` view while the operator and programmatic consumers see the
 * rich `userSummary` + structured `data` views. See issue #48.
 *
 * The tools here are the building block for both `createWorkspaceTools`
 * (rooted at cwd) and `createMemoryTools` (prefixed, agent-scoped). Neither
 * wrapper changes the contract — they add deny-list / prefix behaviour
 * above this layer.
 */

import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import type { MemoryStore } from '../stores.js';
import type { ToolResult } from './types.js';
import {
  DEFAULT_MAX_READ_BYTES,
  DEFAULT_MAX_WRITE_BYTES,
  DEFAULT_MAX_GREP_LINE_BYTES,
  sanitiseFsError,
  truncateUtf8ByBytes,
  utf8ByteLength,
  wrapForModel,
} from './content-guards.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const s = (schema: z.ZodType): any => schema;

export interface FileToolsOptions {
  /** Max bytes we return to the model from a single read. */
  maxReadBytes?: number;
  /** Max bytes the model can write in one call. */
  maxWriteBytes?: number;
  /** Max bytes per line returned from `grep_file`. */
  maxGrepLineBytes?: number;
}

/**
 * Helper: make an error-shaped ToolResult from a caught fs error.
 */
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
 * Create a set of file-manipulation tools backed by a MemoryStore.
 *
 * @param store - Any MemoryStore implementation (in-memory, filesystem, etc.)
 * @param agentId - The agent ID to scope file operations to
 * @param options - Size caps and other knobs; defaults match v0.2 guidance
 * @returns A ToolSet containing read_file, write_file, list_directory,
 *          edit_file, delete_file, grep_file, find_files
 */
export function createFileTools(
  store: MemoryStore,
  agentId: string,
  options: FileToolsOptions = {},
): ToolSet {
  const maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const maxWriteBytes = options.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES;
  const maxGrepLineBytes = options.maxGrepLineBytes ?? DEFAULT_MAX_GREP_LINE_BYTES;

  return {
    read_file: tool({
      description:
        'Read the contents of a file at the given path. Returns the text wrapped in <tool_output> markers. Large files are truncated to a byte cap; the tool result reports the full original size.',
      inputSchema: s(z.object({ path: z.string().describe('The file path to read') })),
      execute: async ({ path }: { path: string }): Promise<ToolResult> => {
        try {
          const body = await store.read(agentId, path);
          const wrapped = wrapForModel(body, {
            tool: 'read_file',
            path,
            maxBytes: maxReadBytes,
          });
          const lines = body.split('\n').length;
          const truncatedNote = wrapped.truncated
            ? `, truncated to ${wrapped.includedBytes} of ${wrapped.totalBytes}`
            : '';
          const markerNote = wrapped.redactedMarkerCount > 0
            ? `, redacted ${wrapped.redactedMarkerCount} potential injection marker${wrapped.redactedMarkerCount === 1 ? '' : 's'}`
            : '';
          return {
            modelContent: wrapped.content,
            userSummary: `[read_file] ${path} — ${wrapped.totalBytes} bytes, ${lines} line${lines === 1 ? '' : 's'}${truncatedNote}${markerNote}`,
            data: {
              path,
              bytes: wrapped.totalBytes,
              lines,
              truncated: wrapped.truncated,
              redactedMarkerCount: wrapped.redactedMarkerCount,
            },
          };
        } catch (err) {
          return errorResult(err, 'read_file', path);
        }
      },
    }),

    write_file: tool({
      description:
        'Write content to a file. Creates parent directories as needed. Content exceeding the per-call size cap is refused.',
      inputSchema: s(
        z.object({
          path: z.string().describe('The file path to write to'),
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
            modelContent: `Refused: content is ${bytes} bytes, limit is ${maxWriteBytes}. Split the write or reduce size.`,
            userSummary: `[write_file] ${path} — REFUSED (${bytes} > ${maxWriteBytes} bytes)`,
            data: {
              path,
              bytes,
              limit: maxWriteBytes,
              blocked: true,
              reason: 'write-size-limit',
            },
            blocked: true,
          };
        }
        try {
          await store.write(agentId, path, content);
          return {
            modelContent: `Wrote ${bytes} bytes to ${path}`,
            userSummary: `[write_file] ${path} — ${bytes} bytes`,
            data: { path, bytes },
          };
        } catch (err) {
          return errorResult(err, 'write_file', path);
        }
      },
    }),

    edit_file: tool({
      description:
        'Edit a file by replacing an exact string match. The old_string must appear exactly once in the file.',
      inputSchema: s(
        z.object({
          path: z.string().describe('The file path to edit'),
          old_string: z.string().describe('The exact text to find and replace'),
          new_string: z.string().describe('The replacement text'),
        }),
      ),
      execute: async ({
        path,
        old_string,
        new_string,
      }: {
        path: string;
        old_string: string;
        new_string: string;
      }): Promise<ToolResult> => {
        try {
          const content = await store.read(agentId, path);
          if (!content.includes(old_string)) {
            return {
              modelContent: `Error: old_string not found in ${path}`,
              userSummary: `[edit_file] ${path} — old_string not found`,
              data: { path, error: 'old-string-missing' },
            };
          }
          const occurrences = content.split(old_string).length - 1;
          if (occurrences > 1) {
            return {
              modelContent: `Error: old_string found ${occurrences} times in ${path} — must be unique. Provide more context to match exactly once.`,
              userSummary: `[edit_file] ${path} — old_string is non-unique (${occurrences} matches)`,
              data: { path, error: 'old-string-non-unique', occurrences },
            };
          }
          const updated = content.replace(old_string, new_string);
          const newBytes = utf8ByteLength(updated);
          if (newBytes > maxWriteBytes) {
            return {
              modelContent: `Refused: post-edit content is ${newBytes} bytes, limit is ${maxWriteBytes}.`,
              userSummary: `[edit_file] ${path} — REFUSED (${newBytes} > ${maxWriteBytes} bytes)`,
              data: {
                path,
                bytes: newBytes,
                limit: maxWriteBytes,
                blocked: true,
                reason: 'write-size-limit',
              },
              blocked: true,
            };
          }
          await store.write(agentId, path, updated);
          return {
            modelContent: `Successfully edited ${path}`,
            userSummary: `[edit_file] ${path} — replaced 1 occurrence, now ${newBytes} bytes`,
            data: {
              path,
              bytes: newBytes,
              replaced: 1,
              oldLength: old_string.length,
              newLength: new_string.length,
            },
          };
        } catch (err) {
          return errorResult(err, 'edit_file', path);
        }
      },
    }),

    list_directory: tool({
      description: 'List files and directories at the given path. Returns names and types.',
      inputSchema: s(
        z.object({
          path: z.string().optional().describe('The directory path to list (defaults to root)'),
        }),
      ),
      execute: async ({ path }: { path?: string }): Promise<ToolResult> => {
        const listPath = path ?? '.';
        try {
          const entries = await store.list(agentId, path);
          if (entries.length === 0) {
            return {
              modelContent: 'Directory is empty or does not exist.',
              userSummary: `[list_directory] ${listPath} — empty or missing`,
              data: { path: listPath, count: 0 },
            };
          }
          const rendered = entries
            .map((e) => `${e.type === 'directory' ? '[dir]' : '[file]'} ${e.name}`)
            .join('\n');
          const dirs = entries.filter((e) => e.type === 'directory').length;
          const files = entries.length - dirs;
          return {
            modelContent: rendered,
            userSummary: `[list_directory] ${listPath} — ${entries.length} entries (${dirs} dirs, ${files} files)`,
            data: { path: listPath, count: entries.length, dirs, files },
          };
        } catch (err) {
          return errorResult(err, 'list_directory', listPath);
        }
      },
    }),

    delete_file: tool({
      description: 'Delete a file at the given path.',
      inputSchema: s(
        z.object({
          path: z.string().describe('The file path to delete'),
        }),
      ),
      execute: async ({ path }: { path: string }): Promise<ToolResult> => {
        try {
          await store.delete(agentId, path);
          return {
            modelContent: `Successfully deleted ${path}`,
            userSummary: `[delete_file] ${path}`,
            data: { path },
          };
        } catch (err) {
          return errorResult(err, 'delete_file', path);
        }
      },
    }),

    grep_file: tool({
      description:
        'Search for a text pattern across files. Returns matching file paths and lines. ' +
        'Default is a literal substring match (case-insensitive). Pass `regex: true` to ' +
        'use a regular expression — patterns are checked for catastrophic backtracking ' +
        'before compiling and rejected if too long or shaped like (a+)+.',
      inputSchema: s(
        // The 256-char cap is a regex-mode guard (ReDoS surface scales
        // with pattern length); literal substring searches safely
        // accept longer strings (e.g. a pasted error signature). The
        // store-level `buildLineMatcher` applies the cap only in regex
        // mode, so lifting it here keeps the tool schema aligned with
        // the underlying policy. See PR #63 review.
        z.object({
          pattern: z.string().describe('The text pattern to search for. Literal substring by default.'),
          path: z.string().optional().describe('Directory to search within (defaults to root)'),
          regex: z.boolean().optional().describe('Treat pattern as a regex (opt-in; safety-checked)'),
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
              userSummary: `[grep_file] "${pattern}" under ${scope} — 0 matches`,
              data: { pattern, scope, matchCount: 0, fileCount: 0 },
            };
          }
          const fileSet = new Set(results.map((r) => r.path));
          // Cap each line by UTF-8 bytes (the option is named …Bytes).
          // Multi-byte characters could otherwise sneak past a char-count
          // cap. The ellipsis is included in the budget so we never emit
          // a line whose byte length exceeds the cap.
          const ellipsis = '…';
          const ellipsisBytes = utf8ByteLength(ellipsis);
          const rendered = results
            .map((r) => {
              if (utf8ByteLength(r.line) <= maxGrepLineBytes) {
                return `${r.path}: ${r.line}`;
              }
              const budget = Math.max(0, maxGrepLineBytes - ellipsisBytes);
              return `${r.path}: ${truncateUtf8ByBytes(r.line, budget)}${ellipsis}`;
            })
            .join('\n');
          return {
            modelContent: rendered,
            userSummary: `[grep_file] "${pattern}" under ${scope} — ${results.length} match${results.length === 1 ? '' : 'es'} in ${fileSet.size} file${fileSet.size === 1 ? '' : 's'}`,
            data: {
              pattern,
              scope,
              matchCount: results.length,
              fileCount: fileSet.size,
            },
          };
        } catch (err) {
          return errorResult(err, 'grep_file', scope);
        }
      },
    }),

    find_files: tool({
      description: 'List all files and directories recursively from a path. Useful for discovering file structure.',
      inputSchema: s(
        z.object({
          path: z.string().optional().describe('Starting directory (defaults to root)'),
        }),
      ),
      execute: async ({ path }: { path?: string }): Promise<ToolResult> => {
        const scope = path ?? '.';
        try {
          const result: string[] = [];
          await listRecursive(store, agentId, path ?? '', '', result);
          if (result.length === 0) {
            return {
              modelContent: 'No files found.',
              userSummary: `[find_files] ${scope} — 0 entries`,
              data: { path: scope, count: 0 },
            };
          }
          return {
            modelContent: result.join('\n'),
            userSummary: `[find_files] ${scope} — ${result.length} entries`,
            data: { path: scope, count: result.length },
          };
        } catch (err) {
          return errorResult(err, 'find_files', scope);
        }
      },
    }),
  };
}

async function listRecursive(
  store: MemoryStore,
  agentId: string,
  basePath: string,
  prefix: string,
  result: string[],
): Promise<void> {
  const fullPath = basePath ? (prefix ? `${basePath}/${prefix}` : basePath) : prefix;
  const entries = await store.list(agentId, fullPath || undefined);
  for (const entry of entries) {
    const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    result.push(`${entry.type === 'directory' ? '[dir]' : '[file]'} ${entryPath}`);
    if (entry.type === 'directory') {
      await listRecursive(store, agentId, basePath, entryPath, result);
    }
  }
}
