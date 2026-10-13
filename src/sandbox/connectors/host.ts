/**
 * Host sandbox — direct passthrough to the host system.
 *
 * Implements {@link SandboxApi} by talking to `node:fs/promises` and
 * `node:child_process` directly. **Not a security boundary** — agents
 * can read, write, and execute anywhere the Node.js process can. Use
 * it when:
 *
 * - You want the `SandboxApi` *shape* (e.g. so tools like
 *   `createBashTool` work) without adding isolation.
 * - You're running tests and want to exercise the contract against
 *   real fs / child_process behaviour.
 * - You're shipping to an environment that already provides isolation
 *   at a higher layer (Docker, Firecracker microVM, gVisor, Deno
 *   Sandbox, Vercel Sandbox) and just need the API surface.
 *
 * For real in-process isolation, use {@link createJustBashSandbox}.
 *
 * ## Environment policy
 *
 * `exec()` used to hand the **whole** parent process environment to
 * every model-controlled command, which meant a `bash` tool call could
 * `printenv` the provider API keys the parent needed
 * (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AWS_SECRET_ACCESS_KEY`, …).
 * It now forwards only {@link DEFAULT_ENV_ALLOWLIST} (plus any names in
 * `envPassthrough`, plus the caller-supplied `ExecOptions.env`) by
 * default. `inheritEnv: true` restores the old whole-environment
 * behaviour and is an explicit, documented opt-out — see
 * {@link HostSandboxOptions}.
 *
 * This closes the *inheritance* path, which is the one a tool call
 * reaches by default. It does not turn the host connector into a
 * security boundary: the command still runs as the same user in the
 * same PID namespace, so on Linux it can read the parent's environment
 * through the process table (`cat /proc/$PPID/environ`). Only real
 * isolation (a container/VM connector, or {@link createJustBashSandbox})
 * changes that.
 */

import * as fsp from 'node:fs/promises';
import { exec as cpExec } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  SandboxApi,
  FileStat,
  ExecOptions,
  ExecResult,
} from '../types.js';

const execAsync = promisify(cpExec);

/**
 * Parent-process environment variables the host connector forwards to
 * commands by default.
 *
 * Two rules shape this list:
 *
 * 1. **No credentials.** Nothing that names a secret — `*_API_KEY`,
 *    `*_TOKEN`, `*_SECRET*`, `AWS_*`, `SSH_AUTH_SOCK`, `HTTPS_PROXY`
 *    (which may embed proxy credentials) — is forwarded. That is a
 *    property of the allowlist, not of a deny pattern: an unlisted name
 *    is simply not passed, so a secret under an unusual name cannot
 *    leak either.
 * 2. **No child-process code injection.** `NODE_OPTIONS`, `BASH_ENV`,
 *    `ENV`, `SHELLOPTS`, `LD_PRELOAD`, `DYLD_*` and friends are
 *    excluded deliberately: forwarding them lets whoever controls the
 *    parent environment run code inside every command.
 *
 * `PATH` and `HOME` are load-bearing (command resolution, npm/cache
 * directories); the locale and terminal names keep ordinary CLI output
 * sane. Add anything else you genuinely need through
 * `HostSandboxOptions.envPassthrough`, and read its doc before you do.
 */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'TMPDIR',
  'TZ',
  'TERM',
  'SHELL',
  'USER',
  'LOGNAME',
  'NODE_ENV',
];

/**
 * Additional names forwarded on Windows hosts, where process creation
 * and DLL resolution depend on system variables that POSIX doesn't have
 * (`cmd.exe` needs `SystemRoot`; `%TEMP%` is the scratch directory).
 *
 * Only added when the child environment is a Windows environment block
 * — i.e. when {@link pickExecEnv}'s `caseInsensitive` flag is set, which
 * defaults to `process.platform === 'win32'`. A POSIX parent can define
 * these names (they are not inherently absent there), so forwarding them
 * unconditionally would widen the default environment beyond the policy
 * documented in docs/sandbox.md (agent-do-s8s).
 */
export const DEFAULT_ENV_ALLOWLIST_WINDOWS: readonly string[] = [
  'SystemRoot',
  'SystemDrive',
  'windir',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
];

/**
 * Name prefixes forwarded by default, so the rest of the locale family
 * (`LC_CTYPE`, `LC_MESSAGES`, …) comes along with `LC_ALL`. Prefix
 * matching is intentionally limited to this list — a user-supplied
 * `envPassthrough` entry is an exact name, never a pattern.
 */
export const DEFAULT_ENV_PREFIX_ALLOWLIST: readonly string[] = ['LC_'];

/**
 * Build the environment for one `exec()` call.
 *
 * Pure and exported so it can be tested directly against a fake parent
 * environment — no dependence on the real `process.env` of the test
 * runner.
 *
 * @param parent the environment to read from (`process.env` in
 *   production).
 * @param extra additional **exact** variable names to forward.
 * @param caseInsensitive the child environment is a Windows environment
 *   block: names are compared ignoring case (Windows blocks are, and the
 *   search path is spelled `Path`) and the Windows platform set
 *   ({@link DEFAULT_ENV_ALLOWLIST_WINDOWS}) applies. Defaults to
 *   `process.platform === 'win32'`, so a POSIX child never receives the
 *   Windows-only names even when the parent happens to define them.
 */
export function pickExecEnv(
  parent: Record<string, string | undefined>,
  extra: readonly string[] = [],
  caseInsensitive = process.platform === 'win32',
): Record<string, string> {
  const normalize = (name: string) =>
    caseInsensitive ? name.toUpperCase() : name;
  const exact = new Set<string>(
    [
      ...DEFAULT_ENV_ALLOWLIST,
      ...(caseInsensitive ? DEFAULT_ENV_ALLOWLIST_WINDOWS : []),
      ...extra,
    ].map(normalize),
  );
  const prefixes = DEFAULT_ENV_PREFIX_ALLOWLIST.map(normalize);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    const key = normalize(name);
    if (exact.has(key) || prefixes.some((prefix) => key.startsWith(prefix))) {
      out[name] = value;
    }
  }
  return out;
}

export interface HostSandboxOptions {
  /**
   * Default `cwd` applied to `exec()` calls that don't supply their own.
   * Falls back to `process.cwd()` when omitted.
   */
  cwd?: string;
  /**
   * Forward the **whole** parent process environment to commands — the
   * pre-0.8 behaviour. Default `false`.
   *
   * Set this only when the commands you run genuinely need the parent
   * environment and you have accepted that the model can read every
   * variable in it: the shell tool runs whatever the model asks, so
   * `env`, `printenv` or `/proc/self/environ` exposes the lot —
   * including provider credentials. When you need a handful of extra
   * names, prefer {@link HostSandboxOptions.envPassthrough}.
   */
  inheritEnv?: boolean;
  /**
   * Additional parent environment variable **names** to forward when
   * `inheritEnv` is `false`, e.g. `['GIT_AUTHOR_NAME']`. Exact names
   * only; no globs or prefixes. Ignored under `inheritEnv: true`
   * (everything is forwarded there anyway).
   *
   * Each name you add widens what a model-controlled command can read,
   * so name specific, non-secret variables rather than reaching for a
   * pattern.
   */
  envPassthrough?: readonly string[];
}

export function createHostSandbox(options: HostSandboxOptions = {}): SandboxApi {
  const defaultCwd = options.cwd;

  return {
    async readFile(path) {
      return await fsp.readFile(path, 'utf-8');
    },
    async readFileBuffer(path) {
      const buf = await fsp.readFile(path);
      // Copy into a fresh Uint8Array so callers can't accidentally
      // mutate Node's internal pool-backed Buffer. The
      // `new Uint8Array(buf)` ctor copies; the three-arg form would
      // alias.
      return new Uint8Array(buf);
    },
    async writeFile(path, content) {
      if (typeof content === 'string') {
        await fsp.writeFile(path, content, 'utf-8');
      } else {
        await fsp.writeFile(path, content);
      }
    },
    async stat(path): Promise<FileStat> {
      // lstat (not stat): follow the SandboxApi contract — describe the
      // path itself, not its target. fsp.stat() always returns
      // isSymbolicLink=false because it follows symlinks first, which
      // makes the bit useless for callers that need to detect them
      // (most importantly SandboxBackedMemoryStore's containment check).
      const s = await fsp.lstat(path);
      return {
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        isSymbolicLink: s.isSymbolicLink(),
        size: s.size,
        mtime: s.mtime,
      };
    },
    async readdir(path) {
      return await fsp.readdir(path);
    },
    async exists(path) {
      try {
        await fsp.stat(path);
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return false;
        throw err;
      }
    },
    async mkdir(path, opts) {
      await fsp.mkdir(path, { recursive: opts?.recursive ?? false });
    },
    async rm(path, opts) {
      await fsp.rm(path, {
        recursive: opts?.recursive ?? false,
        force: opts?.force ?? false,
      });
    },
    async realpath(path) {
      // Used by SandboxBackedMemoryStore to enforce tenant isolation
      // against symlink escape (an `alice/link → ../bob` symlink would
      // otherwise let writes to `alice/link/secret.txt` land in Bob's
      // directory). fsp.realpath follows every symlink in the chain.
      return await fsp.realpath(path);
    },
    async exec(command, opts: ExecOptions = {}): Promise<ExecResult> {
      // allowlisted parent env (or the whole parent env when the caller
      // opted in), then any explicit per-call env — which is
      // caller-supplied library code, not model input, so it always
      // applies and wins.
      const inherited = options.inheritEnv
        ? { ...process.env }
        : pickExecEnv(process.env, options.envPassthrough);
      const env = opts.env ? { ...inherited, ...opts.env } : inherited;
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: opts.cwd ?? defaultCwd,
          env,
          timeout: opts.timeout,
        });
        return { stdout: String(stdout), stderr: String(stderr), exitCode: 0 };
      } catch (err) {
        // node's exec rejects on non-zero exit; surface stdout/stderr
        // and the actual exit code instead of throwing.
        const e = err as NodeJS.ErrnoException & {
          stdout?: string | Buffer;
          stderr?: string | Buffer;
          code?: number | string;
          killed?: boolean;
          signal?: string;
        };
        const exitCode =
          typeof e.code === 'number'
            ? e.code
            : e.killed
              ? 124 // conventional timeout exit
              : 1;
        return {
          stdout: e.stdout ? String(e.stdout) : '',
          stderr: e.stderr ? String(e.stderr) : String(e.message ?? ''),
          exitCode,
        };
      }
    },
  };
}
