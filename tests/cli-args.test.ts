import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/cli/args.js';

describe('parseArgs', () => {
  it('defaults to prompt command with no args', () => {
    const args = parseArgs([]);
    expect(args.command).toBe('prompt');
    expect(args.prompt).toBeUndefined();
    expect(args.provider).toBe('anthropic');
    expect(args.maxIterations).toBe(20);
    expect(args.exclude).toEqual([]);
    expect(args.includeSensitive).toBe(false);
    expect(args.showContent).toBe(false);
  });

  it('parses a simple prompt', () => {
    const args = parseArgs(['Hello', 'world']);
    expect(args.command).toBe('prompt');
    expect(args.prompt).toBe('Hello world');
  });

  it('parses quoted prompt', () => {
    const args = parseArgs(['What is TypeScript?']);
    expect(args.prompt).toBe('What is TypeScript?');
  });

  it('recognizes run subcommand', () => {
    const args = parseArgs(['run', 'my-agent.ts']);
    expect(args.command).toBe('run');
    expect(args.file).toBe('my-agent.ts');
  });

  it('recognizes run subcommand with task', () => {
    const args = parseArgs(['run', 'script.ts', 'do', 'something']);
    expect(args.command).toBe('run');
    expect(args.file).toBe('script.ts');
    expect(args.prompt).toBe('do something');
  });

  it('recognizes eval subcommand', () => {
    const args = parseArgs(['eval', 'evals/basic.ts']);
    expect(args.command).toBe('eval');
    expect(args.file).toBe('evals/basic.ts');
  });

  it('parses --provider', () => {
    const args = parseArgs(['--provider', 'google', 'hello']);
    expect(args.provider).toBe('google');
    expect(args.prompt).toBe('hello');
  });

  it('parses --model', () => {
    const args = parseArgs(['--model', 'gpt-4o', 'hello']);
    expect(args.model).toBe('gpt-4o');
  });

  it('parses --system', () => {
    const args = parseArgs(['--system', 'Be brief.', 'hello']);
    expect(args.systemPrompt).toBe('Be brief.');
  });

  it('parses --memory', () => {
    const args = parseArgs(['--memory', '/tmp/data', 'hello']);
    expect(args.memoryDir).toBe('/tmp/data');
  });

  it('parses --read-only', () => {
    const args = parseArgs(['--read-only', 'hello']);
    expect(args.readOnly).toBe(true);
  });

  it('parses --max-iterations', () => {
    const args = parseArgs(['--max-iterations', '5', 'hello']);
    expect(args.maxIterations).toBe(5);
  });

  it('parses --no-tools', () => {
    const args = parseArgs(['--no-tools', 'hello']);
    expect(args.noTools).toBe(true);
  });

  it('parses --verbose', () => {
    const args = parseArgs(['--verbose', 'hello']);
    expect(args.verbose).toBe(true);
  });

  it('parses --json', () => {
    const args = parseArgs(['--json', 'hello']);
    expect(args.json).toBe(true);
  });

  it('parses --help', () => {
    const args = parseArgs(['--help']);
    expect(args.help).toBe(true);
  });

  it('parses -h as help', () => {
    const args = parseArgs(['-h']);
    expect(args.help).toBe(true);
  });

  // Eval-specific
  it('parses --output for eval', () => {
    const args = parseArgs(['eval', 'file.ts', '--output', 'json']);
    expect(args.output).toBe('json');
  });

  it('parses --output csv', () => {
    const args = parseArgs(['eval', 'file.ts', '--output', 'csv']);
    expect(args.output).toBe('csv');
  });

  it('parses --compare', () => {
    const args = parseArgs(['eval', 'file.ts', '--compare', 'anthropic,google,openai']);
    expect(args.compare).toEqual(['anthropic', 'google', 'openai']);
  });

  it('parses --concurrency', () => {
    const args = parseArgs(['eval', 'file.ts', '--concurrency', '4']);
    expect(args.concurrency).toBe(4);
  });

  // Error cases
  it('throws on unknown option', () => {
    expect(() => parseArgs(['--unknown'])).toThrow('Unknown option');
  });

  it('throws when --provider has no value', () => {
    expect(() => parseArgs(['--provider'])).toThrow('requires a value');
  });

  it('throws when --max-iterations is not a number', () => {
    expect(() => parseArgs(['--max-iterations', 'abc'])).toThrow('positive integer');
  });

  it('throws when --max-iterations is zero', () => {
    expect(() => parseArgs(['--max-iterations', '0'])).toThrow('positive integer');
  });

  it('throws when --output is invalid', () => {
    expect(() => parseArgs(['eval', 'f.ts', '--output', 'xml'])).toThrow('must be console, json, or csv');
  });

  it('throws when run has no file', () => {
    expect(() => parseArgs(['run'])).toThrow('Usage');
  });

  it('throws when eval has no file (and no --help)', () => {
    expect(() => parseArgs(['eval'])).toThrow('Usage');
  });

  it('eval with --help does not throw', () => {
    const args = parseArgs(['eval', '--help']);
    expect(args.help).toBe(true);
  });

  // Combined options
  it('handles multiple flags together', () => {
    const args = parseArgs([
      '--provider', 'openai',
      '--model', 'gpt-4o',
      '--verbose',
      '--read-only',
      '--max-iterations', '10',
      'Summarize this',
    ]);
    expect(args.provider).toBe('openai');
    expect(args.model).toBe('gpt-4o');
    expect(args.verbose).toBe(true);
    expect(args.readOnly).toBe(true);
    expect(args.maxIterations).toBe(10);
    expect(args.prompt).toBe('Summarize this');
  });

  it('flags before and after prompt', () => {
    const args = parseArgs(['--verbose', 'hello', 'world']);
    expect(args.verbose).toBe(true);
    expect(args.prompt).toBe('hello world');
  });

  // Create and list commands
  it('recognizes create subcommand', () => {
    const args = parseArgs(['create', 'my-agent', '--provider', 'google']);
    expect(args.command).toBe('create');
    expect(args.agentName).toBe('my-agent');
    expect(args.provider).toBe('google');
  });

  it('create with all options', () => {
    const args = parseArgs([
      'create', 'reviewer',
      '--provider', 'anthropic',
      '--model', 'claude-haiku-4-5',
      '--system', 'Review code.',
      '--memory', '/tmp/data',
      '--read-only',
      '--no-tools',
    ]);
    expect(args.command).toBe('create');
    expect(args.agentName).toBe('reviewer');
    expect(args.model).toBe('claude-haiku-4-5');
    expect(args.systemPrompt).toBe('Review code.');
    expect(args.readOnly).toBe(true);
    expect(args.noTools).toBe(true);
  });

  it('throws when create has no name', () => {
    expect(() => parseArgs(['create'])).toThrow('Usage');
  });

  it('create with --help does not throw', () => {
    const args = parseArgs(['create', '--help']);
    expect(args.help).toBe(true);
  });

  it('recognizes list subcommand', () => {
    const args = parseArgs(['list']);
    expect(args.command).toBe('list');
  });

  it('recognizes scheduled-tasks run subcommand', () => {
    const args = parseArgs(['scheduled-tasks', 'run', 'ea-sweep', '--script', './agent.ts', '--yes']);
    expect(args.command).toBe('scheduled-tasks');
    expect(args.schedulerAction).toBe('run');
    expect(args.schedulerTaskId).toBe('ea-sweep');
    // For `scheduled-tasks`, `--script <path>` consumes the next argv
    // as the script path. The legacy boolean form is kept for `run`.
    expect(args.file).toBe('./agent.ts');
    expect(args.script).toBe(true);
    expect(args.yes).toBe(true);
  });

  it('keeps --script as a boolean for `run` (legacy form)', () => {
    // `agent-do run ./file.ts --script -y` — the positional is the
    // file, `--script` is the "yes I know" confirmation flag.
    const args = parseArgs(['run', './agent.ts', '--script', '-y']);
    expect(args.command).toBe('run');
    expect(args.file).toBe('./agent.ts');
    expect(args.script).toBe(true);
  });

  it('recognizes scheduled-tasks start / status / install', () => {
    for (const action of ['start', 'status', 'install'] as const) {
      const args = parseArgs(['scheduled-tasks', action]);
      expect(args.command).toBe('scheduled-tasks');
      expect(args.schedulerAction).toBe(action);
    }
  });

  it('rejects scheduled-tasks with no action', () => {
    expect(() => parseArgs(['scheduled-tasks'])).toThrow(/Usage: npx agent-do scheduled-tasks/);
  });

  it('rejects scheduled-tasks run without a task id', () => {
    expect(() => parseArgs(['scheduled-tasks', 'run'])).toThrow(/scheduled-tasks run <task-id>/);
  });

  it('parses --exclude as comma-separated patterns (repeatable)', () => {
    const args = parseArgs(['--exclude', 'secrets/**,*.cred', '--exclude', 'vendor/**']);
    expect(args.exclude).toEqual(['secrets/**', '*.cred', 'vendor/**']);
  });

  it('parses --include-sensitive', () => {
    const args = parseArgs(['--include-sensitive']);
    expect(args.includeSensitive).toBe(true);
  });

  it('--show-content implies --verbose', () => {
    const args = parseArgs(['--show-content']);
    expect(args.showContent).toBe(true);
    expect(args.verbose).toBe(true);
  });
});
