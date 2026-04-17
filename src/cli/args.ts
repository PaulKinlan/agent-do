/**
 * CLI argument parser.
 *
 * Zero-dependency argument parsing. Supports flags, options with values,
 * and positional arguments.
 */

export interface ParsedArgs {
  command: 'prompt' | 'run' | 'eval' | 'create' | 'list';
  prompt?: string;
  file?: string;
  agentName?: string;
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
    acceptAll: false,
    allow: [],
  };

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
      args.verbose = true;
    } else if (arg === '--show-content') {
      args.showContent = true;
      // Showing full content implies verbose output; otherwise the flag
      // has nothing to attach to in the default quiet mode.
      args.verbose = true;
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
    } else if (arg === '--accept-all' || arg === '--yes' || arg === '-y') {
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
  } else {
    // prompt mode — all positional args become the prompt
    if (positional.length > 0) {
      args.prompt = positional.join(' ');
    }
  }

  return args;
}

function requireValue(argv: string[], index: number, flag: string): string {
  if (index >= argv.length || argv[index]!.startsWith('-')) {
    throw new Error(`${flag} requires a value`);
  }
  return argv[index]!;
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
