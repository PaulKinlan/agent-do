/**
 * CLI argument parser.
 *
 * Zero-dependency argument parsing. Supports flags, options with values,
 * and positional arguments.
 */

export interface ParsedArgs {
  command: 'prompt' | 'run' | 'eval' | 'create' | 'list' | 'scheduled-tasks';
  prompt?: string;
  file?: string;
  agentName?: string;
  /**
   * Sub-subcommand for `scheduled-tasks`: `run` | `start` | `status` |
   * `install`. Only set when `command === 'scheduled-tasks'`.
   */
  schedulerAction?: 'run' | 'start' | 'status' | 'install';
  /**
   * Task id, positional after `scheduled-tasks run`. Required for the
   * `run` action, ignored by other scheduler actions.
   */
  schedulerTaskId?: string;
  provider: string;
  model?: string;
  systemPrompt: string;
  workingDir: string;
  memoryDir: string;
  withMemory: boolean;
  readOnly: boolean;
  maxIterations: number;
  noTools: boolean;
  verbose: boolean;
  /**
   * Show full tool results (file bodies, etc.) in verbose output. Default
   * only shows the structured one-line summary per tool call so secrets
   * and large payloads stay out of terminals / CI logs.
   */
  showContent: boolean;
  json: boolean;
  help: boolean;
  /**
   * Extra deny-list patterns (gitignore-style) added on top of the
   * built-in defaults and any `.agent-doignore` in the working directory.
   */
  exclude: string[];
  /**
   * Bypass the built-in sensitive-file deny list (`.env`, `.ssh/**`,
   * credential material). `--exclude` and `.agent-doignore` still apply.
   */
  includeSensitive: boolean;
  // Eval-specific
  output: 'console' | 'json' | 'csv';
  compare?: string[];
  concurrency: number;
  /**
   * Opt-in for script-file import (#19, C-03). Without this flag, `run
   * <path>` refuses to `await import()` a local file. Only saved-agent
   * names are accepted unless the user explicitly says "yes I know what
   * I'm doing, run arbitrary code from this path."
   */
  script: boolean;
  /**
   * Skip interactive confirmation when `--script` is passed. Required for
   * non-TTY contexts (CI, shell piping) that can't prompt.
   *
   * `-y`/`--yes` sets both this flag and `acceptAll` — the operator
   * meaning is the same ("skip all interactive prompts this run"), so
   * it would be surprising to have them diverge.
   */
  yes: boolean;
  /**
   * Accept every tool call without prompting (#17, C-01).
   *
   * Previously the CLI hard-coded this behaviour. The default now asks
   * for confirmation on destructive tools (write, edit, delete) in TTY
   * mode and denies them in non-TTY mode. `--accept-all` restores the
   * old "full yolo" behaviour for scripted pipelines that need it —
   * but the operator now has to opt in explicitly.
   */
  acceptAll: boolean;
  /**
   * Comma-separated list of tool names that bypass the confirmation
   * prompt (e.g. `--allow write_file,memory_write`). Useful for
   * semi-automated sessions where some destructive tools are expected.
   */
  allow: string[];
  /**
   * CLI log level (#72). Graduated observability:
   *
   * - `silent` — no stderr output, only the final answer on stdout
   * - `info` (default) — errors only; final answer on stdout
   * - `verbose` — adds thinking deltas + tool call/result summaries
   *   (what `--verbose` used to do)
   * - `debug` — adds system-prompt + messages + cache + request
   *   metadata; raw response parts appear as compact summaries
   * - `trace` — adds full raw stream parts (every text-delta /
   *   tool-input-delta / finish event)
   *
   * Derived from `--log-level <level>` or from the legacy
   * `--verbose` / `--show-content` / `--json` flag combinations for
   * backward compatibility.
   */
  logLevel: 'silent' | 'info' | 'verbose' | 'debug' | 'trace';
}

/**
 * Parse CLI arguments into a structured object.
 *
 * Handles subcommands (run, eval), flags, and options.
 * Remaining positional args become the prompt.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: 'prompt',
    provider: 'anthropic',
    systemPrompt: 'You are a helpful assistant.',
    workingDir: process.cwd(),
    memoryDir: '.agent-do',
    withMemory: false,
    readOnly: false,
    maxIterations: 20,
    noTools: false,
    verbose: false,
    showContent: false,
    json: false,
    help: false,
    exclude: [],
    includeSensitive: false,
    output: 'console',
    concurrency: 1,
    script: false,
    yes: false,
    acceptAll: false,
    allow: [],
    logLevel: 'info',
  };
  // Track whether --log-level was explicitly set so backward-compat
  // --verbose / --show-content don't silently demote a higher level
  // picked by the operator.
  let explicitLogLevel = false;
  // Track whether --show-content was passed so it overrides the
  // log-level-derived showContent default (which is on at `debug`+
  // but off at `verbose`). `--log-level verbose --show-content`
  // keeps showContent on.
  let explicitShowContent = false;

  const positional: string[] = [];
  let i = 0;

  // Check for subcommand
  if (argv.length > 0) {
    const first = argv[0];
    if (first === 'run') {
      args.command = 'run';
      i = 1;
    } else if (first === 'eval') {
      args.command = 'eval';
      i = 1;
    } else if (first === 'create') {
      args.command = 'create';
      i = 1;
    } else if (first === 'list') {
      args.command = 'list';
      i = 1;
    } else if (first === 'scheduled-tasks') {
      args.command = 'scheduled-tasks';
      i = 1;
      const action = argv[1];
      if (action === 'run' || action === 'start' || action === 'status' || action === 'install') {
        args.schedulerAction = action;
        i = 2;
        if (action === 'run') {
          const taskId = argv[2];
          if (taskId && !taskId.startsWith('-')) {
            args.schedulerTaskId = taskId;
            i = 3;
          }
        }
      }
    }
  }

  while (i < argv.length) {
    const arg = argv[i]!;

    if (arg === '-h' || arg === '--help') {
      args.help = true;
    } else if (arg === '--provider') {
      args.provider = requireValue(argv, ++i, '--provider');
    } else if (arg === '--model') {
      args.model = requireValue(argv, ++i, '--model');
    } else if (arg === '--system') {
      args.systemPrompt = requireValue(argv, ++i, '--system');
    } else if (arg === '--cwd' || arg === '--working-dir') {
      args.workingDir = requireValue(argv, ++i, arg);
    } else if (arg === '--memory') {
      args.memoryDir = requireValue(argv, ++i, '--memory');
    } else if (arg === '--with-memory') {
      args.withMemory = true;
    } else if (arg === '--read-only') {
      args.readOnly = true;
    } else if (arg === '--max-iterations') {
      const val = requireValue(argv, ++i, '--max-iterations');
      args.maxIterations = parseInt(val, 10);
      if (isNaN(args.maxIterations) || args.maxIterations < 1) {
        throw new Error('--max-iterations must be a positive integer');
      }
    } else if (arg === '--no-tools') {
      args.noTools = true;
    } else if (arg === '--verbose') {
      // Legacy alias: nudges logLevel up to at least `verbose` when
      // the operator hasn't explicitly picked a level. Final
      // verbose/showContent booleans are derived from logLevel after
      // the parse loop finishes, so ordering doesn't matter.
      if (!explicitLogLevel && levelRank(args.logLevel) < levelRank('verbose')) {
        args.logLevel = 'verbose';
      }
    } else if (arg === '--show-content') {
      // --show-content bumps visibility to verbose AND asks for full
      // tool-result bodies without going all the way to debug level.
      // Track the content opt-in separately so --log-level info
      // --show-content still honours the intent to show content.
      if (!explicitLogLevel && levelRank(args.logLevel) < levelRank('verbose')) {
        args.logLevel = 'verbose';
      }
      explicitShowContent = true;
    } else if (arg === '--log-level') {
      const val = requireValue(argv, ++i, '--log-level');
      if (val !== 'silent' && val !== 'info' && val !== 'verbose' && val !== 'debug' && val !== 'trace') {
        throw new Error('--log-level must be one of: silent, info, verbose, debug, trace');
      }
      args.logLevel = val;
      explicitLogLevel = true;
    } else if (arg === '--exclude') {
      const val = requireValue(argv, ++i, '--exclude');
      args.exclude.push(...val.split(',').map((s) => s.trim()).filter(Boolean));
    } else if (arg === '--include-sensitive') {
      args.includeSensitive = true;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--output') {
      const val = requireValue(argv, ++i, '--output');
      if (val !== 'console' && val !== 'json' && val !== 'csv') {
        throw new Error('--output must be console, json, or csv');
      }
      args.output = val;
    } else if (arg === '--compare') {
      const val = requireValue(argv, ++i, '--compare');
      args.compare = val.split(',').map(s => s.trim()).filter(Boolean);
    } else if (arg === '--concurrency') {
      const val = requireValue(argv, ++i, '--concurrency');
      args.concurrency = parseInt(val, 10);
      if (isNaN(args.concurrency) || args.concurrency < 1) {
        throw new Error('--concurrency must be a positive integer');
      }
    } else if (arg === '--script') {
      // Dual form (#79):
      // - `agent-do run <file> --script` — `--script` is a boolean
      //   confirming "yes I know I'm executing this positional file".
      // - `agent-do scheduled-tasks <action> --script <path>` —
      //   `--script` takes the path because there's no positional for
      //   the file.
      //
      // Disambiguate by command: for `scheduled-tasks` we always
      // consume the next argv as the path; everything else keeps the
      // legacy boolean semantics so existing `run --script` calls
      // don't break.
      args.script = true;
      if (args.command === 'scheduled-tasks') {
        args.file = requireValue(argv, ++i, '--script');
      }
    } else if (arg === '--accept-all') {
      args.acceptAll = true;
    } else if (arg === '-y' || arg === '--yes') {
      // `-y`/`--yes` means "skip all interactive prompts this run": it
      // satisfies both the `--script` confirmation prompt AND the
      // per-tool permission prompt, so set both flags. Operators who
      // only want one semantic should use the specific flag name
      // (`--accept-all` for permissions without implying script confirm,
      // or vice versa when/if a dedicated flag lands).
      args.yes = true;
      args.acceptAll = true;
    } else if (arg === '--allow') {
      const val = requireValue(argv, ++i, '--allow');
      args.allow.push(...val.split(',').map((s) => s.trim()).filter(Boolean));
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}. Use --help for usage.`);
    } else {
      positional.push(arg);
    }

    i++;
  }

  // Assign positional args based on command
  if (args.command === 'run') {
    if (positional.length === 0) {
      throw new Error('Usage: npx agent-do run <file-or-agent-name> [task]');
    }
    args.file = positional[0];
    args.prompt = positional.slice(1).join(' ') || undefined;
  } else if (args.command === 'eval') {
    if (positional.length === 0 && !args.help) {
      throw new Error('Usage: npx agent-do eval <file|dir>');
    }
    args.file = positional[0];
  } else if (args.command === 'create') {
    if (positional.length === 0 && !args.help) {
      throw new Error('Usage: npx agent-do create <name> [options]');
    }
    args.agentName = positional[0];
  } else if (args.command === 'list') {
    // no positional args needed
  } else if (args.command === 'scheduled-tasks') {
    if (!args.schedulerAction && !args.help) {
      throw new Error(
        'Usage: npx agent-do scheduled-tasks <run|start|status|install> [options]',
      );
    }
    if (args.schedulerAction === 'run' && !args.schedulerTaskId && !args.help) {
      throw new Error('Usage: npx agent-do scheduled-tasks run <task-id> [options]');
    }
  } else {
    // prompt mode — all positional args become the prompt
    if (positional.length > 0) {
      args.prompt = positional.join(' ');
    }
  }

  // Derive `verbose` and `showContent` from the final `logLevel`.
  // `logLevel` is the single source of truth for `verbose` —
  // legacy flags bump it during parse, explicit `--log-level` wins
  // over legacy flags regardless of argument order. Copilot #73
  // flagged that the old layered logic let `--verbose --log-level
  // info` still run in verbose mode.
  //
  // `showContent` has a small escape hatch: the legacy `--show-content`
  // flag turns it on independently of log level, so
  // `--log-level verbose --show-content` still prints full tool
  // bodies without promoting all the way to `debug`.
  args.verbose = levelRank(args.logLevel) >= levelRank('verbose');
  // showContent is on when:
  //  - logLevel is debug or trace (implicit), OR
  //  - --show-content was passed AND the effective logLevel is at
  //    least verbose. An explicit `--log-level silent` or `info`
  //    still wins over the legacy flag — otherwise `--show-content
  //    --log-level silent` would contradict itself.
  args.showContent =
    levelRank(args.logLevel) >= levelRank('debug') ||
    (explicitShowContent && levelRank(args.logLevel) >= levelRank('verbose'));

  return args;
}

function requireValue(argv: string[], index: number, flag: string): string {
  if (index >= argv.length || argv[index]!.startsWith('-')) {
    throw new Error(`${flag} requires a value`);
  }
  return argv[index]!;
}

/**
 * Ordinal for CLI log levels. Used so the legacy `--verbose` flag
 * doesn't accidentally demote an already-higher level set via
 * `--log-level`. (#72)
 */
export function levelRank(level: ParsedArgs['logLevel']): number {
  switch (level) {
    case 'silent': return 0;
    case 'info': return 1;
    case 'verbose': return 2;
    case 'debug': return 3;
    case 'trace': return 4;
  }
}

/**
 * Read stdin if it's being piped (non-TTY).
 * Returns the piped content or undefined if stdin is a TTY.
 */
export async function readStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }

  const content = Buffer.concat(chunks).toString('utf-8').trim();
  return content || undefined;
}
