/**
 * `createSandboxedToolset` — convenience bundle for the common case.
 *
 * Wires the file tools (read/write/edit/list/delete/grep/find) and a
 * `bash` tool against a single {@link SandboxApi}. Equivalent to:
 *
 *   const store = new SandboxBackedMemoryStore(sandbox, root);
 *   const tools = {
 *     ...createFileTools(store, agentId, fileToolsOptions),
 *     ...createBashTool(sandbox, bashOptions),
 *   };
 *
 * If you need finer control (e.g. file tools against one root and bash
 * exec against another), assemble the pieces yourself.
 */

import type { ToolSet } from 'ai';
import type { SandboxApi } from '../sandbox/types.js';
import {
  SandboxBackedMemoryStore,
  type SandboxBackedMemoryStoreOptions,
} from '../stores/sandbox.js';
import { createFileTools, type FileToolsOptions } from './file-tools.js';
import { createBashTool, type CreateBashToolOptions } from './bash-tool.js';

export interface CreateSandboxedToolsetOptions {
  /** Root directory inside the sandbox. Defaults to `/workspace`. */
  root?: string;
  /** Forwarded to {@link SandboxBackedMemoryStore}. */
  store?: SandboxBackedMemoryStoreOptions;
  /** Forwarded to {@link createFileTools}. */
  fileTools?: FileToolsOptions;
  /** Forwarded to {@link createBashTool}. Set `false` to omit the bash tool. */
  bash?: CreateBashToolOptions | false;
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
  if (options.bash === false) return fileTools;
  const bashTools = createBashTool(sandbox, options.bash);
  return { ...fileTools, ...bashTools };
}
