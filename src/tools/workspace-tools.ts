/**
 * Workspace tools — file operations against a working directory.
 *
 * Unlike memory tools, which give the agent a sandboxed scratchpad,
 * workspace tools let the agent read and write real project files.
 * They default to the current working directory and respect path-
 * traversal guards inherited from FilesystemMemoryStore.
 *
 * Usage:
 *   import { createWorkspaceTools } from 'agent-do';
 *
 *   const tools = createWorkspaceTools(process.cwd());
 *   // read-only mode — agent can read but not modify:
 *   const readOnlyTools = createWorkspaceTools(process.cwd(), { readOnly: true });
 */

import type { ToolSet } from 'ai';
import { FilesystemMemoryStore } from '../stores/filesystem.js';
import { createFileTools } from './file-tools.js';

export interface WorkspaceToolsOptions {
  /** Block all writes. Default: false. */
  readOnly?: boolean;
  /** Called before any write op. Return false to deny. */
  onBeforeWrite?: (
    canonicalPath: string,
    operation: 'write' | 'append' | 'delete' | 'mkdir',
  ) => boolean | Promise<boolean>;
}

/**
 * Create workspace file tools rooted at a working directory.
 *
 * The returned ToolSet (read_file, write_file, list_directory, edit_file,
 * delete_file, grep_file, find_files) operates relative to `workingDir`.
 * All paths are resolved inside `workingDir` — `..` traversal is blocked.
 */
export function createWorkspaceTools(
  workingDir: string,
  options?: WorkspaceToolsOptions,
): ToolSet {
  const store = new FilesystemMemoryStore(workingDir, {
    readOnly: options?.readOnly,
    onBeforeWrite: options?.onBeforeWrite
      ? async (_agentId, canonicalPath, op) =>
          options.onBeforeWrite!(canonicalPath, op)
      : undefined,
  });
  // Empty agentId lets tools see the whole workingDir (not a per-agent subdir).
  return createFileTools(store, '');
}
