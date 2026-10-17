import { afterEach, expect, it, vi } from 'vitest';

// The help command should print its options without running a prompt or model.
vi.mock('../src/cli/prompt.js', () => ({ runPromptMode: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

it('documents default search, permissions and the prompt-mode opt-out in --help', async () => {
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'agent-do', '--help']);
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  await import('../src/cli.js');
  expect(exit).toHaveBeenCalledWith(0);
  const help = output.mock.calls.map(call => call.join(' ')).join('\n');
  expect(help).toContain('--no-search');
  expect(help).toContain('mcp__parallel__web_search');
  expect(help).toContain('mcp__parallel__web_fetch');
  expect(help).toContain('Explicit --provider-tool');
});
