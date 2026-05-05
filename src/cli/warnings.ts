/**
 * Startup warnings for the CLI.
 *
 * Called from every CLI entry point so that the sandbox warning fires
 * for `run`, `eval`, and prompt mode — not only the interactive path —
 * and appears before any long operation (stdin reads, model init) so
 * the user sees it at the moment they invoke the tool.
 *
 * The API takes the *resolved* tool/read-only state explicitly rather
 * than raw `args.noTools`, because saved agents and script-mode
 * exports can override CLI flags. Codex flagged on PR #47 that
 * `npx agent-do run <saved> --no-tools` could suppress the warning
 * while a saved agent that itself has `noTools: false` still ran with
 * full file access.
 */

export interface SandboxWarningOptions {
  /** True when file tools will actually be enabled for this run. */
  toolsEnabled: boolean;
  /** True when writes are blocked but reads/list/grep are still on. */
  readOnly: boolean;
  /** Suppress all stderr output for programmatic consumers. */
  json: boolean;
}

/**
 * Emit the "no sandbox" warning to stderr based on the resolved tool
 * configuration.
 *
 * Wording is scoped to the working directory (not the whole filesystem)
 * because path-traversal guards in the store keep the agent inside the
 * configured root. Even under `--read-only`, the agent can still
 * enumerate and read files in that scope — which leaks content to the
 * model provider — so we still emit a (narrower) warning in that case.
 *
 * Suppressed entirely when tools are off (no surface to warn about) or
 * `--json` is set (programmatic consumer; clean stdio).
 */
export function emitSandboxWarning(opts: SandboxWarningOptions): void {
  if (!opts.toolsEnabled) return;
  if (opts.json) return;

  const message = opts.readOnly
    ? '⚠️  agent-do is running in --read-only mode. Writes are blocked, but the agent can still ' +
      'read, list, and grep files under the working directory (and send their contents to the ' +
      'model provider). Use --no-tools to disable filesystem access entirely.\n\n'
    : '⚠️  agent-do is not sandboxed: it can read, write, edit, and delete files under the ' +
      'working directory. Use --read-only to block writes, or --no-tools to disable all ' +
      'filesystem access.\n\n';

  process.stderr.write(message);
}
