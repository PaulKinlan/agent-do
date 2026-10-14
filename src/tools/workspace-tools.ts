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
import { SandboxBackedMemoryStore } from '../stores/sandbox.js';
import type { MemoryStore } from '../stores.js';
import type { SandboxApi } from '../sandbox/types.js';
import { createFileTools, type FileToolsOptions } from './file-tools.js';
import {
  blockedByDenyList,
  createDenyGuard,
  type DenyGuard,
} from './deny-list.js';
import type { ToolResult } from './types.js';
import { wrapForModel } from './content-guards.js';
import { escapeForLine } from './content-guards.js';

/**
 * The structured match records grep_file / memory_search put in `ToolResult.data.matches`.
 *
 * Validated rather than trusted: the deny-list decision reads `path`, so anything other than a string path
 * is treated as "no usable list" and nothing is passed through. Returns null when the caller supplied no
 * list, or a malformed one - never a partial one.
 */
/**
 * The structured entry records list_directory / find_files put in `ToolResult.data.entries`.
 *
 * Validated rather than trusted, like readMatchRecords: the deny-list decision reads `path`, so anything
 * other than a string path means "no usable list" and nothing is passed through.
 */
export function readListEntries(
  data: Record<string, unknown> | undefined,
): Array<{ type: string; path: string }> | null {
  const value = data?.entries;
  if (!Array.isArray(value)) return null;
  const out: Array<{ type: string; path: string }> = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const { type, path } = item as { type?: unknown; path?: unknown };
    if (typeof path !== 'string' || typeof type !== 'string') return null;
    out.push({ type, path });
  }
  return out;
}

export function readMatchRecords(data: Record<string, unknown> | undefined): Array<{ path: string; line: string }> | null {
  const value = data?.matches;
  if (!Array.isArray(value)) return null;
  const out: Array<{ path: string; line: string }> = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const { path, line } = item as { path?: unknown; line?: unknown };
    if (typeof path !== 'string' || typeof line !== 'string') return null;
    out.push({ path, line });
  }
  return out;
}


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
  /**
   * Pluggable sandbox connector (#3). When set, file operations route
   * through {@link SandboxBackedMemoryStore} backed by this sandbox
   * instead of `FilesystemMemoryStore`. `workingDir` is then
   * interpreted *inside the sandbox*, not on the host. The deny-list
   * still applies on top.
   *
   * Use this when you want hard isolation — e.g. an in-process
   * just-bash sandbox, or a remote VM connector — and you want the
   * existing workspace-tools ergonomics (cwd-relative paths,
   * sensitive-file deny-list) on top.
   *
   * Leave undefined to keep the legacy behaviour: file ops go directly
   * to host fs through `FilesystemMemoryStore`.
   */
  sandbox?: SandboxApi;
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
  const store: MemoryStore = options.sandbox
    ? new SandboxBackedMemoryStore(options.sandbox, workingDir, {
        readOnly: options.readOnly,
        onBeforeWrite: options.onBeforeWrite
          ? async (_agentId, canonicalPath, op) =>
              options.onBeforeWrite!(canonicalPath, op)
          : undefined,
      })
    : new FilesystemMemoryStore(workingDir, {
        readOnly: options.readOnly,
        onBeforeWrite: options.onBeforeWrite
          ? async (_agentId, canonicalPath, op) =>
              options.onBeforeWrite!(canonicalPath, op)
          : undefined,
      });

  // .agent-doignore is read via host `node:fs` inside `createDenyGuard`.
  // When `options.sandbox` is set, file ops live on the sandbox's
  // substrate (e.g. just-bash's virtual fs) — reading the host's
  // .agent-doignore for a workspace at, say, `/work` would either find
  // an unrelated file or none at all, silently mis-applying ignore
  // rules. Force-skip the .agent-doignore lookup in that case; the
  // built-in defaults and `options.exclude` patterns still apply.
  // Document this limitation in docs/sandbox.md.
  const skipAgentDoIgnore =
    options.skipAgentDoIgnore ?? Boolean(options.sandbox);
  const guard = createDenyGuard(workingDir, {
    sandbox: options.sandbox,
    extra: options.exclude,
    includeSensitive: options.includeSensitive,
    skipAgentDoIgnore,
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
          const read = await guard.checkRead(p);
          if (read.blocked) return blockedByDenyList(toolName, p, read);
          if (op !== 'read') {
            const write = await guard.checkWrite(p);
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
          const decision = await guard.checkWrite(p);
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
        // Entries come from data.entries, which list_directory/find_files fill alongside the rendered text
        // (agent-do-0fr). They used to be recovered by parsing "[dir] name" lines, which a filename
        // containing a newline could forge: the continuation was a syntax-valid entry line, so a name minted
        // an entry that did not exist. The tool now escapes the name AND reports records, so this reads
        // records and never parses text.
        const entries = readListEntries(result.data);
        if (entries === null) {
          const claimed = result.data?.count;
          // No structured entry list: a contract violation by the caller. The one recovery we must not
          // attempt is guessing entries out of the text, so nothing is passed through. A listing with no
          // entries has nothing to leak and is returned untouched.
          if (typeof claimed === 'number' && claimed > 0) {
            return {
              modelContent: '(entries withheld: the tool did not report them in a form the deny list can check)',
              userSummary: `${result.userSummary}, all entries hidden (no structured entry list to check)`,
              data: { ...(result.data ?? {}), hiddenByDenyList: claimed, count: 0, entries: [] },
              blocked: result.blocked,
            };
          }
          return result;
        }
        const kept: Array<{ type: string; path: string }> = [];
        let hidden = 0;
        for (const e of entries) {
          // Both `list_directory` and `find_files` report paths relative to the *scan root* (immediate
          // child names, or nested paths under it). Prepend basePath in either case so deny rules matching
          // workspace-relative globs (`.ssh/**`, `.git/objects/**`, etc.) actually match.
          if ((await guard.checkRead(joinForCheck(basePath, e.path))).blocked) {
            hidden++;
            continue;
          }
          kept.push(e);
        }
        if (hidden === 0) return result;
        const modelContent = kept.length === 0
          ? `(all ${entries.length} entries hidden by deny list)`
          : `${kept.map((e) => `${e.type === 'directory' ? '[dir]' : '[file]'} ${escapeForLine(e.path)}`).join('\n')}\n... ${hidden} entr${hidden === 1 ? 'y' : 'ies'} hidden by deny list`;
        return {
          modelContent,
          userSummary: `${result.userSummary}, ${hidden} hidden by deny list`,
          data: { ...(result.data ?? {}), hiddenByDenyList: hidden, count: kept.length, entries: kept },
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
        // Filter grep hits whose path is deny-listed. The paths come from data.matches, which grep_file
        // fills alongside the rendered text (agent-do-2rm). Recovering them by re-parsing modelContent was
        // the bug: the rendered format is "path: line", so a ':' inside a path made line.indexOf(':')
        // return a truncated prefix, that prefix was checked instead of the real path, and a deny-listed
        // file was passed through unfiltered AND unredacted.
        const matches = readMatchRecords(result.data);
        if (matches === null) {
          const claimed = result.data?.matchCount;
          // No structured match list. That is a contract violation by the caller, and the one recovery we
          // must not attempt is guessing paths out of the text - so nothing is passed through. A result
          // with no matches has nothing to leak and is returned untouched.
          if (typeof claimed === 'number' && claimed > 0) {
            return {
              modelContent: '(matches withheld: the tool did not report their paths for deny-list checking)',
              userSummary: `${result.userSummary}, all matches hidden (no structured match list to check)`,
              data: { ...(result.data ?? {}), hiddenByDenyList: claimed, matchCount: 0, matches: [] },
            };
          }
          return result;
        }
        const kept: Array<{ path: string; line: string }> = [];
        let hidden = 0;
        for (const m of matches) {
          if ((await guard.checkRead(m.path)).blocked) {
            hidden++;
            continue;
          }
          kept.push(m);
        }
        if (hidden === 0) return result;
        const body = kept.length === 0
          ? '(all matches hidden by deny list)'
          : `${kept.map((m) => `${m.path}: ${m.line}`).join('\n')}\n... ${hidden} match${hidden === 1 ? '' : 'es'} hidden by deny list`;
        // Re-render through the same framing the tool uses. The tool already framed the unfiltered text, so
        // building the filtered text without re-wrapping would either drop the frame or nest a second one;
        // wrapping the body keeps exactly one frame around what is actually returned.
        const wrapped = kept.length === 0
          ? null
          : wrapForModel(body, { tool: 'grep_file', path: String(result.data?.scope ?? '.') });
        return {
          modelContent: wrapped ? wrapped.content : body,
          userSummary: `${result.userSummary}, ${hidden} match${hidden === 1 ? '' : 'es'} hidden by deny list`,
          data: {
            ...(result.data ?? {}),
            hiddenByDenyList: hidden,
            matchCount: kept.length,
            matches: kept,
          },
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
