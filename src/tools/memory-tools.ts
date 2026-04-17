/**
 * Memory tools — the agent's private scratchpad.
 *
 * Unlike workspace tools, which expose real project files, memory tools
 * give the agent a dedicated, per-agent storage area for notes, plans,
 * and learned facts. The agent can persist information across runs
 * without touching the user's project.
 *
 * Tools are prefixed `memory_*` so the agent understands they operate
 * on its own memory, not the workspace.
 *
 * Usage:
 *   import { createMemoryTools, FilesystemMemoryStore } from 'agent-do';
 *
 *   const store = new FilesystemMemoryStore('.agent-do');
 *   const tools = createMemoryTools(store, 'my-agent');
 */

import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import type { MemoryStore } from '../stores.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const s = (schema: z.ZodType): any => schema;

/**
 * Create memory-scoped tools backed by a MemoryStore.
 *
 * Emits `memory_read`, `memory_write`, `memory_list`, `memory_delete`,
 * and `memory_search`. All operations are scoped to the given agentId,
 * so agents can't read each other's memory.
 */
export function createMemoryTools(store: MemoryStore, agentId: string): ToolSet {
  return {
    memory_read: tool({
      description:
        "Read a file from the agent's private memory. Use this to recall notes, plans, or facts you wrote in a previous turn or session.",
      inputSchema: s(
        z.object({
          path: z.string().describe('Path within memory (e.g. "notes.md")'),
        }),
      ),
      execute: async ({ path }: { path: string }) => {
        try {
          return await store.read(agentId, path);
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
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
      execute: async ({ path, content }: { path: string; content: string }) => {
        try {
          await store.write(agentId, path, content);
          return `Wrote to memory: ${path}`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
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
      execute: async ({ path }: { path?: string }) => {
        try {
          const entries = await store.list(agentId, path);
          if (entries.length === 0) return 'Memory is empty.';
          return entries
            .map((e) => `${e.type === 'directory' ? '[dir]' : '[file]'} ${e.name}`)
            .join('\n');
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
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
      execute: async ({ path }: { path: string }) => {
        try {
          await store.delete(agentId, path);
          return `Deleted from memory: ${path}`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    memory_search: tool({
      description: "Search the agent's private memory for a pattern.",
      inputSchema: s(
        z.object({
          pattern: z.string().describe('Text or regex pattern to search for'),
          path: z
            .string()
            .optional()
            .describe('Subdirectory to search within (defaults to root)'),
        }),
      ),
      execute: async ({ pattern, path }: { pattern: string; path?: string }) => {
        try {
          const results = await store.search(agentId, pattern, path);
          if (results.length === 0) return `No matches found for "${pattern}"`;
          return results.map((r) => `${r.path}: ${r.line}`).join('\n');
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };
}
