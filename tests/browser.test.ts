import { describe, it, expect } from 'vitest';
import * as esbuild from 'esbuild';
import { isBuiltin } from 'node:module';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const nodeForbiddenPlugin: esbuild.Plugin = {
  name: 'node-forbidden',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (isBuiltin(args.path) || args.path.startsWith('node:')) {
        return {
          errors: [
            {
              text: `Node builtin "${args.path}" forbidden in browser bundle (importer: ${args.importer || '<entry>'})`,
            },
          ],
        };
      }
    });
  },
};

describe('browser entry point (agent-do/browser)', () => {
  it('bundles with esbuild platform=browser with all Node builtins forbidden', async () => {
    const result = await esbuild.build({
      entryPoints: ['./src/browser.ts'],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'esm',
      external: ['ai', 'zod', 'zod/*', 'yaml'],
      plugins: [nodeForbiddenPlugin],
      metafile: true,
    });

    expect(result.errors).toEqual([]);
    const inputs = Object.keys(result.metafile?.inputs ?? {});
    for (const name of ['cross-spawn', 'client/stdio', 'shebang', 'path-key', 'file-lock']) {
      expect(inputs.some((p) => p.includes(name))).toBe(false);
    }
  });

  it('runs in a browser-like VM context without process or global globals', async () => {
    const cjs = await esbuild.build({
      entryPoints: ['./src/browser.ts'],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'cjs',
      external: ['ai', 'zod', 'zod/*', 'yaml'],
      plugins: [nodeForbiddenPlugin],
    });

    const context: Record<string, unknown> = {
      module: { exports: {} },
      require: (id: string) => {
        if (id === 'ai') return require('ai');
        if (id.startsWith('zod')) return require(id);
        if (id === 'yaml') return require('yaml');
        throw new Error(`Unexpected require: ${id}`);
      },
      console,
      Event,
      EventTarget,
      MessageEvent,
      TextEncoder,
      TextDecoder,
      URL,
      URLSearchParams,
      AbortController,
      ReadableStream,
      TransformStream,
      crypto,
      setTimeout,
      clearTimeout,
    };

    runInNewContext(cjs.outputFiles[0].text, context);
    expect(context.process).toBeUndefined();
    expect(context.global).toBeUndefined();

    const exports = (context.module as { exports: Record<string, unknown> }).exports;
    expect(typeof exports.createAgent).toBe('function');
    expect(typeof exports.matchesCron).toBe('function');
    expect(typeof exports.validateScheduledTasks).toBe('function');
    expect(typeof exports.InMemoryRoutineStore).toBe('function');
    expect(typeof exports.InMemoryMemoryStore).toBe('function');
    expect(typeof exports.mountMcpServers).toBe('function');

    // Filesystem helpers must NOT be exported in browser entry
    expect(exports.FilesystemMemoryStore).toBeUndefined();
    expect(exports.FilesystemRoutineStore).toBeUndefined();
    expect(exports.acquireFileLock).toBeUndefined();
    expect(exports.runScheduledTask).toBeUndefined();
    expect(exports.createHostSandbox).toBeUndefined();
    expect(exports.createShellTool).toBeUndefined();
    expect(exports.createWorkspaceTools).toBeUndefined();

    // Verify creating an agent in browser context
    const createAgent = exports.createAgent as (config: unknown) => { id: string };
    const agent = createAgent({
      id: 'browser-agent',
      name: 'Browser Agent',
      model: {},
      scheduledTasks: [{ id: 'task-1', cron: '*/5 * * * *', payload: 'check' }],
    });
    expect(agent.id).toBe('browser-agent');

    // Verify stdio transport rejection in browser context
    const mountMcpServers = exports.mountMcpServers as (
      configs: unknown[],
    ) => Promise<unknown>;
    await expect(
      mountMcpServers([
        {
          name: 'local',
          transport: { type: 'stdio', command: 'node' },
        },
      ]),
    ).rejects.toThrow(/stdio transport is not supported in browser environment/);
  });
});
