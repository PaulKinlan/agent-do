/**
 * `createSandboxedToolset` — convenience bundle for the common case.
 *
 * Wires the file tools (read/write/edit/list/delete/grep/find) and a
 * shell tool against a single {@link SandboxApi}. Equivalent to:
 *
 *   const store = new SandboxBackedMemoryStore(sandbox, root);
 *   const tools = {
 *     ...createFileTools(store, agentId, fileToolsOptions),
 *     ...createShellTool(sandbox, shellOptions),
 *   };
 *
 * If you need finer control (e.g. file tools against one root and a
 * shell against another), assemble the pieces yourself.
 */

import type { ToolSet } from 'ai';
import type { SandboxApi } from '../sandbox/types.js';
import {
  SandboxBackedMemoryStore,
  type SandboxBackedMemoryStoreOptions,
} from '../stores/sandbox.js';
import { createFileTools, type FileToolsOptions } from './file-tools.js';
import { createShellTool, type CreateShellToolOptions } from './shell-tool.js';

export interface CreateSandboxedToolsetOptions {
  /** Root directory inside the sandbox. Defaults to `/workspace`. */
  root?: string;
  /** Forwarded to {@link SandboxBackedMemoryStore}. */
  store?: SandboxBackedMemoryStoreOptions;
  /** Forwarded to {@link createFileTools}. */
  fileTools?: FileToolsOptions;
  /** Forwarded to {@link createShellTool}. Set `false` to omit the shell tool. */
  shell?: CreateShellToolOptions | false;
}

export function createSandboxedToolset(
  sandbox: SandboxApi,
  agentId: string,
  options: CreateSandboxedToolsetOptions = {},
): ToolSet {
  const store = new SandboxBackedMemoryStore(
    sandbox,
    options.root ?? '/workspace',
    options.store,
  );
  const fileTools = createFileTools(store, agentId, options.fileTools);
  if (options.shell === false) return fileTools;
  const shellTools = createShellTool(sandbox, options.shell);
  return { ...fileTools, ...shellTools };
}
