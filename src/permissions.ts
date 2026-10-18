import type { PermissionConfig } from './types.js';

/**
 * Validate a permission config up front.
 *
 * `mode: 'ask'` means "a human decides", so a config with that mode and no `onPermissionRequest` callback
 * cannot do the one thing it exists to do. It used to fall through to `allow`, which made "ask me first"
 * behave as "allow everything" with no trace anywhere except a comment in the source (agent-do-40r: a
 * fail-open in the one mode that exists to be fail-closed). Rejecting it here is deterministic, names the
 * missing callback, and fails before any tool runs.
 */
export function validatePermissionConfig(config: PermissionConfig): void {
  if (config.mode === 'ask' && !config.onPermissionRequest) {
    throw new Error(
      'Invalid permission config: mode "ask" requires an onPermissionRequest callback. Supply one, or use ' +
        'mode "accept-all"/"deny-all" to decide without asking.',
    );
  }
}

/**
 * Evaluate whether a tool call is permitted.
 *
 * Pipeline:
 * 1. If mode is 'accept-all', return true
 * 2. If mode is 'deny-all', return false
 * 3. Check per-tool overrides: 'always' -> true, 'never' -> false
 * 4. If 'ask' or no override: call onPermissionRequest (required for 'ask' - see validatePermissionConfig)
 */
export async function evaluatePermission(
  toolName: string,
  args: unknown,
  config: PermissionConfig,
): Promise<boolean> {
  // Mode-level shortcuts
  if (config.mode === 'accept-all') {
    // Still check per-tool 'never' overrides
    const toolLevel = config.tools?.[toolName];
    if (toolLevel === 'never') return false;
    return true;
  }

  if (config.mode === 'deny-all') {
    // Still check per-tool 'always' overrides
    const toolLevel = config.tools?.[toolName];
    if (toolLevel === 'always') return true;
    return false;
  }

  // Mode is 'ask' — check per-tool overrides first
  const toolLevel = config.tools?.[toolName];
  if (toolLevel === 'always') return true;
  if (toolLevel === 'never') return false;

  // 'ask' level or no override — call the callback
  if (config.onPermissionRequest) {
    return config.onPermissionRequest({ toolName, args });
  }

  // validatePermissionConfig rejects this combination, so arriving here means a config was built without it.
  // Deny rather than allow: the one thing this mode must never do is silently permit (agent-do-40r).
  return false;
}
