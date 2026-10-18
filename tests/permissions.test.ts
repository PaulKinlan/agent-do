import { describe, it, expect, vi } from 'vitest';
import { evaluatePermission, validatePermissionConfig } from '../src/permissions.js';
import { createAgent } from '../src/agent.js';
import { createMockModel } from '../src/testing/index.js';
import type { AgentConfig, PermissionConfig } from '../src/types.js';

describe('evaluatePermission', () => {
  it('accept-all mode returns true', async () => {
    const config: PermissionConfig = { mode: 'accept-all' };
    expect(await evaluatePermission('any_tool', {}, config)).toBe(true);
  });

  it('deny-all mode returns false', async () => {
    const config: PermissionConfig = { mode: 'deny-all' };
    expect(await evaluatePermission('any_tool', {}, config)).toBe(false);
  });

  it('accept-all with per-tool never override returns false', async () => {
    const config: PermissionConfig = {
      mode: 'accept-all',
      tools: { dangerous_tool: 'never' },
    };
    expect(await evaluatePermission('dangerous_tool', {}, config)).toBe(false);
    expect(await evaluatePermission('safe_tool', {}, config)).toBe(true);
  });

  it('deny-all with per-tool always override returns true', async () => {
    const config: PermissionConfig = {
      mode: 'deny-all',
      tools: { safe_tool: 'always' },
    };
    expect(await evaluatePermission('safe_tool', {}, config)).toBe(true);
    expect(await evaluatePermission('other_tool', {}, config)).toBe(false);
  });

  it('ask mode with always override returns true', async () => {
    const config: PermissionConfig = {
      mode: 'ask',
      tools: { read_file: 'always' },
    };
    expect(await evaluatePermission('read_file', {}, config)).toBe(true);
  });

  it('ask mode with never override returns false', async () => {
    const config: PermissionConfig = {
      mode: 'ask',
      tools: { delete_file: 'never' },
    };
    expect(await evaluatePermission('delete_file', {}, config)).toBe(false);
  });

  it('ask mode calls onPermissionRequest callback', async () => {
    const callback = vi.fn().mockResolvedValue(true);
    const config: PermissionConfig = {
      mode: 'ask',
      onPermissionRequest: callback,
    };
    const result = await evaluatePermission('some_tool', { foo: 'bar' }, config);
    expect(result).toBe(true);
    expect(callback).toHaveBeenCalledWith({
      toolName: 'some_tool',
      args: { foo: 'bar' },
    });
  });

  it('ask mode with callback returning false denies', async () => {
    const config: PermissionConfig = {
      mode: 'ask',
      onPermissionRequest: async () => false,
    };
    expect(await evaluatePermission('tool', {}, config)).toBe(false);
  });

  it('ask mode with no callback denies rather than silently allowing', async () => {
    // agent-do-40r: this used to return true, which made "a human decides" mean "allow everything".
    const config: PermissionConfig = { mode: 'ask' };
    expect(await evaluatePermission('tool', {}, config)).toBe(false);
  });

  it('rejects mode "ask" without a callback at config time', () => {
    expect(() => validatePermissionConfig({ mode: 'ask' })).toThrow(/onPermissionRequest/);
    expect(() => validatePermissionConfig({ mode: 'accept-all' })).not.toThrow();
    expect(() => validatePermissionConfig({ mode: 'deny-all' })).not.toThrow();
    expect(() =>
      validatePermissionConfig({ mode: 'ask', onPermissionRequest: async () => true }),
    ).not.toThrow();
  });

  it('createAgent refuses a config that asks without a way to ask', () => {
    expect(() =>
      createAgent({
        id: 'a',
        name: 'A',
        model: createMockModel({ responses: [] }) as unknown as AgentConfig['model'],
        permissions: { mode: 'ask' },
      }),
    ).toThrow(/onPermissionRequest/);
  });
});
