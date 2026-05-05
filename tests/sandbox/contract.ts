/**
 * Reusable {@link SandboxApi} contract suite.
 *
 * Any implementation of `SandboxApi` should pass this suite. Connectors
 * call `runSandboxApiContract(name, factory)` from their own `*.test.ts`
 * file. The suite probes the round-trip semantics that the bridge layer
 * (`SandboxBackedMemoryStore`) and the bash tool both rely on.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { SandboxApi } from '../../src/sandbox/types.js';

export interface ContractFactoryContext {
  /** Path inside the sandbox that the test owns and may freely mutate. */
  scratchDir: string;
}

export type ContractFactory = (
  ctx: ContractFactoryContext,
) => Promise<{ sandbox: SandboxApi; teardown?: () => Promise<void> }>;

export function runSandboxApiContract(name: string, factory: ContractFactory) {
  describe(`SandboxApi contract: ${name}`, () => {
    let sandbox: SandboxApi;
    let teardown: (() => Promise<void>) | undefined;
    let scratch: string;

    beforeEach(async () => {
      scratch = `/tmp/agent-do-sandbox-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const result = await factory({ scratchDir: scratch });
      sandbox = result.sandbox;
      teardown = result.teardown;
      try {
        await sandbox.mkdir(scratch, { recursive: true });
      } catch {
        // Some connectors create the dir as part of their virtual fs setup.
      }
      return async () => {
        try {
          await sandbox.rm(scratch, { recursive: true, force: true });
        } catch {
          // ignore
        }
        await teardown?.();
      };
    });

    it('writes and reads a file (string round-trip)', async () => {
      const path = `${scratch}/hello.txt`;
      await sandbox.writeFile(path, 'hello world');
      const got = await sandbox.readFile(path);
      expect(got).toBe('hello world');
    });

    it('reports existence', async () => {
      const path = `${scratch}/exists.txt`;
      expect(await sandbox.exists(path)).toBe(false);
      await sandbox.writeFile(path, 'x');
      expect(await sandbox.exists(path)).toBe(true);
    });

    it('mkdir respects recursive option', async () => {
      await sandbox.mkdir(`${scratch}/a/b/c`, { recursive: true });
      expect(await sandbox.exists(`${scratch}/a/b/c`)).toBe(true);
    });

    it('readdir returns only entry names', async () => {
      await sandbox.writeFile(`${scratch}/one.txt`, '1');
      await sandbox.writeFile(`${scratch}/two.txt`, '2');
      const entries = await sandbox.readdir(scratch);
      expect(entries.sort()).toEqual(['one.txt', 'two.txt']);
    });

    it('stat reports isFile / isDirectory', async () => {
      await sandbox.writeFile(`${scratch}/f.txt`, 'x');
      const fStat = await sandbox.stat(`${scratch}/f.txt`);
      expect(fStat.isFile).toBe(true);
      expect(fStat.isDirectory).toBe(false);
      const dStat = await sandbox.stat(scratch);
      expect(dStat.isDirectory).toBe(true);
      expect(dStat.isFile).toBe(false);
    });

    it('rm with force ignores missing paths', async () => {
      // Should not throw. Either it's a no-op (force: true) or it
      // surfaces nothing — we don't care which on the contract level.
      await expect(
        sandbox.rm(`${scratch}/never-existed`, { force: true }),
      ).resolves.toBeUndefined();
    });

    it('rm recursive removes a tree', async () => {
      await sandbox.mkdir(`${scratch}/tree/a`, { recursive: true });
      await sandbox.writeFile(`${scratch}/tree/a/x.txt`, 'x');
      await sandbox.rm(`${scratch}/tree`, { recursive: true, force: true });
      expect(await sandbox.exists(`${scratch}/tree`)).toBe(false);
    });

    it('exec runs a command and reports exit code 0', async () => {
      const r = await sandbox.exec('echo hello');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/hello/);
    });

    it('exec reports a non-zero exit code without throwing', async () => {
      const r = await sandbox.exec('false');
      expect(r.exitCode).not.toBe(0);
    });

    it('readFileBuffer round-trips', async () => {
      const path = `${scratch}/bin.dat`;
      const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      await sandbox.writeFile(path, bytes);
      const got = await sandbox.readFileBuffer(path);
      expect(Array.from(got)).toEqual([72, 101, 108, 108, 111]);
    });
  });
}
