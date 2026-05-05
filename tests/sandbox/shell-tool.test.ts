import { describe, it, expect, vi } from 'vitest';
import { createShellTool } from '../../src/tools/shell-tool.js';
import { createHostSandbox } from '../../src/sandbox/connectors/host.js';
import type { SandboxApi } from '../../src/sandbox/types.js';
import type { ToolResult } from '../../src/tools/types.js';

function getExecute(tools: ReturnType<typeof createShellTool>, name = 'bash') {
  const t = tools[name];
  if (!t || !t.execute) throw new Error(`${name} tool has no execute`);
  return t.execute as (
    args: { command: string; cwd?: string; timeoutMs?: number },
    options?: unknown,
  ) => Promise<ToolResult>;
}

describe('createShellTool', () => {
  it('defaults to a host sandbox when none is supplied — `createShellTool()` works without ceremony', async () => {
    const tools = createShellTool(undefined);
    const exec = getExecute(tools);
    const r = await exec({ command: 'echo default-host' });
    expect(r.data?.exitCode).toBe(0);
    expect(r.modelContent).toMatch(/default-host/);
  });

  it('runs a command via the sandbox and surfaces stdout / exit code', async () => {
    const tools = createShellTool(createHostSandbox());
    const exec = getExecute(tools);
    const r = await exec({ command: 'echo hi' });
    expect(r.modelContent).toMatch(/exit_code: 0/);
    expect(r.modelContent).toMatch(/hi/);
    expect(r.data?.exitCode).toBe(0);
    expect(r.blocked).toBeUndefined();
  });

  it('exposes a tool named `bash` by default', async () => {
    const tools = createShellTool(createHostSandbox());
    expect(tools.bash).toBeDefined();
  });

  it('refuses a per-call timeout above the cap', async () => {
    const tools = createShellTool(createHostSandbox(), { maxTimeoutMs: 5_000 });
    const exec = getExecute(tools);
    const r = await exec({ command: 'echo hi', timeoutMs: 60_000 });
    expect(r.blocked).toBe(true);
    expect(r.data?.reason).toBe('timeout-too-large');
  });

  it('forwards cwd/timeout to sandbox.exec', async () => {
    const spy = vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });
    const sandbox = makeStubSandbox({ exec: spy });
    const tools = createShellTool(sandbox);
    const exec = getExecute(tools);
    await exec({ command: 'ls', cwd: '/tmp', timeoutMs: 1000 });
    expect(spy).toHaveBeenCalledWith('ls', { cwd: '/tmp', timeout: 1000 });
  });

  it('does not throw when the sandbox throws — surfaces an error ToolResult', async () => {
    const sandbox = makeStubSandbox({
      exec: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const tools = createShellTool(sandbox);
    const exec = getExecute(tools);
    const r = await exec({ command: 'whatever' });
    expect(r.userSummary).toMatch(/threw/);
    expect(r.data?.error).toBe(true);
  });

  it('caps stdout/stderr to maxOutputBytes and reports truncation', async () => {
    const big = 'x'.repeat(10_000);
    const sandbox = makeStubSandbox({
      exec: vi.fn().mockResolvedValue({ stdout: big, stderr: '', exitCode: 0 }),
    });
    const tools = createShellTool(sandbox, { maxOutputBytes: 100 });
    const exec = getExecute(tools);
    const r = await exec({ command: 'cat' });
    expect(r.modelContent).toMatch(/truncated/);
    expect(r.data?.stdoutTruncated).toBe(true);
  });

  it('honours the `name` option (e.g. mount as `host_shell`)', async () => {
    const tools = createShellTool(createHostSandbox(), { name: 'host_shell' });
    expect(tools.host_shell).toBeDefined();
    expect(tools.bash).toBeUndefined();
  });
});

function makeStubSandbox(
  overrides: Partial<SandboxApi>,
): SandboxApi {
  const stub: SandboxApi = {
    async readFile() { throw new Error('not implemented'); },
    async readFileBuffer() { throw new Error('not implemented'); },
    async writeFile() { throw new Error('not implemented'); },
    async stat() { throw new Error('not implemented'); },
    async readdir() { throw new Error('not implemented'); },
    async exists() { return false; },
    async mkdir() {},
    async rm() {},
    async exec() { return { stdout: '', stderr: '', exitCode: 0 }; },
  };
  return { ...stub, ...overrides };
}
