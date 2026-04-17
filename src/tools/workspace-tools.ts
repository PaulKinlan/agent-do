/**
 * Workspace tools — file operations against a working directory.
 *
 * Unlike memory tools, which give the agent a sandboxed scratchpad,
 * workspace tools let the agent read and write real project files.
 * They default to the current working directory and respect path-
 * traversal guards inherited from FilesystemMemoryStore, plus a deny
 * list that blocks sensitive defaults (`.env`, `.ssh/**`, `.git/**`
 * writes, `node_modules/**` writes, credential-bearing file patterns).
 *
 * Usage:
 *   import { createWorkspaceTools } from 'agent-do';
 *
 *   const tools = createWorkspaceTools(process.cwd());
 *   // Read-only mode — agent can read but not modify:
 *   const readOnlyTools = createWorkspaceTools(process.cwd(), { readOnly: true });
 *   // Extra project-specific excludes (e.g. from `--exclude`):
 *   const custom = createWorkspaceTools(process.cwd(), {
 *     exclude: ['secrets/**', '*.cred'],
 *   });
 *   // Declare that you know what you're doing and want the defaults off:
 *   const unsafe = createWorkspaceTools(process.cwd(), {
 *     includeSensitive: true,
 *   });
 */

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { FilesystemMemoryStore } from '../stores/filesystem.js';
import { createFileTools, type FileToolsOptions } from './file-tools.js';
import {
  blockedByDenyList,
  createDenyGuard,
  type DenyGuard,
} from './deny-list.js';
import type { ToolResult } from './types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const s = (schema: z.ZodType): any => schema;

export interface WorkspaceToolsOptions extends FileToolsOptions {
  /** Block all writes. Default: false. */
  readOnly?: boolean;
  /** Called before any write op. Return false to deny. */
  onBeforeWrite?: (
    canonicalPath: string,
    operation: 'write' | 'append' | 'delete' | 'mkdir',
  ) => boolean | Promise<boolean>;
  /**
   * Extra deny-list patterns (gitignore-style). Merged with the defaults
   * unless `includeSensitive` is set.
   */
  exclude?: readonly string[];
  /**
   * Opt out of the built-in sensitive-file defaults. The `.agent-doignore`
   * file and any `exclude` patterns still apply.
   */
  includeSensitive?: boolean;
  /** For tests: skip reading `.agent-doignore`. */
  skipAgentDoIgnore?: boolean;
}

/**
 * Create workspace file tools rooted at a working directory.
 *
 * The returned ToolSet (read_file, write_file, list_directory, edit_file,
 * delete_file, grep_file, find_files) operates relative to `workingDir`.
 * Path traversal is blocked by the store; sensitive paths are blocked by
 * the deny-list guard layered above it.
 */
export function createWorkspaceTools(
  workingDir: string,
  options: WorkspaceToolsOptions = {},
): ToolSet {
  const store = new FilesystemMemoryStore(workingDir, {
    readOnly: options.readOnly,
    onBeforeWrite: options.onBeforeWrite
      ? async (_agentId, canonicalPath, op) =>
          options.onBeforeWrite!(canonicalPath, op)
      : undefined,
  });

  const guard = createDenyGuard(workingDir, {
    extra: options.exclude,
    includeSensitive: options.includeSensitive,
    skipAgentDoIgnore: options.skipAgentDoIgnore,
  });

  // Start from the raw file tools (no guard), then wrap the ones whose
  // semantics change under the deny list. Unaffected tools pass through.
  const raw = createFileTools(store, '', {
    maxReadBytes: options.maxReadBytes,
    maxWriteBytes: options.maxWriteBytes,
    maxGrepLineBytes: options.maxGrepLineBytes,
  });

  return applyDenyGuard(raw, guard);
}

/**
 * Wrap a ToolSet with deny-list checks that produce structured blocked
 * ToolResults before the underlying tool ever runs. Reads that match the
 * deny list are refused; writes likewise; listings / greps / finds have
 * denied entries filtered out of the results.
 */
function applyDenyGuard(raw: ToolSet, guard: DenyGuard): ToolSet {
  const wrapRead = (op: 'read' | 'edit' | 'delete', underlying: ToolSet[string]) => {
    const originalExecute = underlying.execute;
    if (!originalExecute) return underlying;
    return {
      ...underlying,
      execute: async (args: unknown, ctx: unknown): Promise<ToolResult> => {
        const p = (args as { path?: string } | undefined)?.path ?? '';
        if (p) {
          const read = guard.checkRead(p);
          if (read.blocked) return blockedByDenyList(op, p, read);
          if (op !== 'read') {
            const write = guard.checkWrite(p);
            if (write.blocked) return blockedByDenyList(op, p, write);
          }
        }
        return (await (originalExecute as Function)(args, ctx)) as ToolResult;
      },
    } as typeof underlying;
  };

  const wrapWrite = (op: 'write' | 'edit' | 'delete', underlying: ToolSet[string]) => {
    const originalExecute = underlying.execute;
    if (!originalExecute) return underlying;
    return {
      ...underlying,
      execute: async (args: unknown, ctx: unknown): Promise<ToolResult> => {
        const p = (args as { path?: string } | undefined)?.path ?? '';
        if (p) {
          const decision = guard.checkWrite(p);
          if (decision.blocked) return blockedByDenyList(op, p, decision);
        }
        return (await (originalExecute as Function)(args, ctx)) as ToolResult;
      },
    } as typeof underlying;
  };

  const wrapList = (op: 'list' | 'find', underlying: ToolSet[string]) => {
    // list_directory / find_files don't deny outright — they just filter
    // denied entries out of the rendered listing. Denied entries are still
    // counted in the data so the operator can see something was hidden.
    const originalExecute = underlying.execute;
    if (!originalExecute) return underlying;
    return {
      ...underlying,
      execute: async (args: unknown, ctx: unknown): Promise<ToolResult> => {
        const result = (await (originalExecute as Function)(args, ctx)) as ToolResult;
        const basePath = ((args as { path?: string } | undefined)?.path ?? '.').replace(/\/?$/, '');
        const lines = result.modelContent.split('\n').filter(Boolean);
        const kept: string[] = [];
        let hidden = 0;
        for (const line of lines) {
          // format: "[dir] name" or "[file] name"
          const m = line.match(/^\[(dir|file)\]\s+(.+)$/);
          if (!m) {
            kept.push(line);
            continue;
          }
          const name = m[2];
          const rel = basePath === '.' || basePath === ''
            ? name
            : op === 'find'
              ? name  // find_files already returns paths relative to the scan root
              : `${basePath}/${name}`;
          if (guard.checkRead(rel).blocked) {
            hidden++;
            continue;
          }
          kept.push(line);
        }
        if (hidden === 0) return result;
        const modelContent = kept.length === 0
          ? `(all ${lines.length} entries hidden by deny list)`
          : `${kept.join('\n')}\n... ${hidden} entr${hidden === 1 ? 'y' : 'ies'} hidden by deny list`;
        return {
          modelContent,
          userSummary: `${result.userSummary}, ${hidden} hidden by deny list`,
          data: { ...(result.data ?? {}), hiddenByDenyList: hidden },
          blocked: result.blocked,
        };
      },
    } as typeof underlying;
  };

  const wrapGrep = (underlying: ToolSet[string]) => {
    const originalExecute = underlying.execute;
    if (!originalExecute) return underlying;
    return {
      ...underlying,
      execute: async (args: unknown, ctx: unknown): Promise<ToolResult> => {
        const result = (await (originalExecute as Function)(args, ctx)) as ToolResult;
        // Filter grep hits whose path is deny-listed. The parsed line
        // format is "path: line" from createFileTools.grep_file.
        const lines = result.modelContent.split('\n').filter(Boolean);
        const kept: string[] = [];
        let hidden = 0;
        for (const line of lines) {
          const colonIndex = line.indexOf(':');
          const maybePath = colonIndex > 0 ? line.slice(0, colonIndex) : line;
          if (guard.checkRead(maybePath).blocked) {
            hidden++;
            continue;
          }
          kept.push(line);
        }
        if (hidden === 0) return result;
        const modelContent = kept.length === 0
          ? '(all matches hidden by deny list)'
          : `${kept.join('\n')}\n... ${hidden} match${hidden === 1 ? '' : 'es'} hidden by deny list`;
        return {
          modelContent,
          userSummary: `${result.userSummary}, ${hidden} match${hidden === 1 ? '' : 'es'} hidden by deny list`,
          data: { ...(result.data ?? {}), hiddenByDenyList: hidden },
        };
      },
    } as typeof underlying;
  };

  // Use tool() to keep the returned objects consistent with what Vercel AI
  // SDK expects downstream. The `tool()` helper preserves description/schema
  // from the underlying definition through spread.
  return {
    read_file: wrapRead('read', raw.read_file!),
    write_file: wrapWrite('write', raw.write_file!),
    edit_file: wrapRead('edit', raw.edit_file!),
    delete_file: wrapWrite('delete', raw.delete_file!),
    list_directory: wrapList('list', raw.list_directory!),
    grep_file: wrapGrep(raw.grep_file!),
    find_files: wrapList('find', raw.find_files!),
  };
}

// Re-export for library consumers who want to define their own tools
// under the same policy.
export { createDenyGuard, DEFAULT_READ_DENY, DEFAULT_WRITE_DENY } from './deny-list.js';
export type { DenyGuard, DenyDecision } from './deny-list.js';
// Silence unused-imports: tool() is retained for future extension.
void tool;
void s;
