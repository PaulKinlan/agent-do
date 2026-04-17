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
  /**
   * Combine a base path (from the tool args) with a child name into a
   * workspace-relative path suitable for deny-list lookup. `list_directory`
   * returns immediate child names (`config`); `find_files` returns
   * paths relative to its scan root (`subdir/file.txt`). Both need
   * `basePath` prefixed so a check against `.ssh/**` actually matches
   * `.ssh/config` rather than just `config`.
   */
  const joinForCheck = (basePath: string, child: string): string => {
    if (basePath === '.' || basePath === '') return child;
    return `${basePath.replace(/\/+$/, '')}/${child}`;
  };

  const wrapRead = (
    toolName: string,
    op: 'read' | 'edit' | 'delete',
    underlying: ToolSet[string],
  ) => {
    const originalExecute = underlying.execute;
    if (!originalExecute) return underlying;
    return {
      ...underlying,
      execute: async (args: unknown, ctx: unknown): Promise<ToolResult> => {
        const p = (args as { path?: string } | undefined)?.path ?? '';
        if (p) {
          const read = guard.checkRead(p);
          if (read.blocked) return blockedByDenyList(toolName, p, read);
          if (op !== 'read') {
            const write = guard.checkWrite(p);
            if (write.blocked) return blockedByDenyList(toolName, p, write);
          }
        }
        return (await (originalExecute as Function)(args, ctx)) as ToolResult;
      },
    } as typeof underlying;
  };

  const wrapWrite = (
    toolName: string,
    underlying: ToolSet[string],
  ) => {
    const originalExecute = underlying.execute;
    if (!originalExecute) return underlying;
    return {
      ...underlying,
      execute: async (args: unknown, ctx: unknown): Promise<ToolResult> => {
        const p = (args as { path?: string } | undefined)?.path ?? '';
        if (p) {
          const decision = guard.checkWrite(p);
          if (decision.blocked) return blockedByDenyList(toolName, p, decision);
        }
        return (await (originalExecute as Function)(args, ctx)) as ToolResult;
      },
    } as typeof underlying;
  };

  const wrapList = (
    toolName: string,
    underlying: ToolSet[string],
  ) => {
    // list_directory / find_files don't deny outright — they just filter
    // denied entries out of the rendered listing. Denied entries are still
    // counted in the data so the operator can see something was hidden.
    const originalExecute = underlying.execute;
    if (!originalExecute) return underlying;
    return {
      ...underlying,
      execute: async (args: unknown, ctx: unknown): Promise<ToolResult> => {
        const requestedPath = (args as { path?: string } | undefined)?.path;
        const result = (await (originalExecute as Function)(args, ctx)) as ToolResult;
        const basePath = (requestedPath ?? '.').replace(/\/?$/, '');
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
          // Both `list_directory` and `find_files` return entry paths
          // relative to the *scan root* (immediate child names, or
          // nested paths under it). Prepend basePath in either case so
          // deny rules matching workspace-relative globs (`.ssh/**`,
          // `.git/objects/**`, etc.) actually match.
          const rel = joinForCheck(basePath, m[2]);
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

  const wrapGrep = (
    toolName: string,
    underlying: ToolSet[string],
  ) => {
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

  return {
    read_file: wrapRead('read_file', 'read', raw.read_file!),
    write_file: wrapWrite('write_file', raw.write_file!),
    edit_file: wrapRead('edit_file', 'edit', raw.edit_file!),
    delete_file: wrapWrite('delete_file', raw.delete_file!),
    list_directory: wrapList('list_directory', raw.list_directory!),
    grep_file: wrapGrep('grep_file', raw.grep_file!),
    find_files: wrapList('find_files', raw.find_files!),
  };
}

// Re-export for library consumers who want to define their own tools
// under the same policy.
export { createDenyGuard, DEFAULT_READ_DENY, DEFAULT_WRITE_DENY } from './deny-list.js';
export type { DenyGuard, DenyDecision } from './deny-list.js';
// Silence unused-imports: tool() is retained for future extension.
void tool;
void s;
