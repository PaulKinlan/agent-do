/**
 * Shared `agentId` validation. Centralised here so the rule can be
 * enforced at every boundary that takes an agent ID, not just in the
 * CLI. See issue #30.
 *
 * The rule was originally in `src/cli/agents.ts` (saved-agent name
 * regex), but `FilesystemMemoryStore.resolve()` happily accepted
 * arbitrary strings and concatenated them into a path. A library
 * caller passing `req.user.id` straight in could create
 * `agentId = '../other-tenant'` and escape the per-agent subdir.
 */

const AGENT_ID_RE = /^[a-zA-Z0-9_-]+$/;
const MAX_AGENT_ID_LENGTH = 64;

/**
 * Throws if `agentId` is not a safe path segment.
 *
 * The empty string is permitted because `createWorkspaceTools` uses
 * agentId `""` to mount file tools at the workspace root rather than a
 * per-agent subdirectory. The store's path-traversal guard handles
 * the rest.
 */
export function validateAgentId(agentId: string): void {
  if (typeof agentId !== 'string') {
    throw new Error('agentId must be a string');
  }
  if (agentId.length === 0) return; // workspace-tools mode
  if (agentId.length > MAX_AGENT_ID_LENGTH) {
    throw new Error(
      `agentId too long (${agentId.length} > ${MAX_AGENT_ID_LENGTH}).`,
    );
  }
  if (!AGENT_ID_RE.test(agentId)) {
    throw new Error(
      `Invalid agentId "${agentId}". Use only alphanumerics, dashes, and underscores.`,
    );
  }
}
