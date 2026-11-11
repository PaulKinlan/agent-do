import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, symlink, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { SandboxBackedMemoryStore } from '../../src/stores/sandbox.js';
import { createHostSandbox } from '../../src/sandbox/connectors/host.js';
import type { SandboxApi } from '../../src/sandbox/types.js';

/**
 * SandboxBackedMemoryStore round-trip tests. The host sandbox is just a
 * `node:fs/promises` passthrough — perfect for confirming the bridge
 * preserves MemoryStore semantics (path scoping, idempotent delete,
 * search). Real isolation is covered by the connector tests; this file
 * is about the adapter layer.
 */

describe('SandboxBackedMemoryStore', () => {
  let root: string;
  let store: SandboxBackedMemoryStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'agent-do-sbms-'));
    store = new SandboxBackedMemoryStore(createHostSandbox(), root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes and reads under {root}/{agentId}/', async () => {
    await store.write('alice', 'a/b.txt', 'body');
    expect(await store.read('alice', 'a/b.txt')).toBe('body');
    // Tenant isolation: bob's view doesn't see alice's file.
    expect(await store.exists('bob', 'a/b.txt')).toBe(false);
  });

  it('list returns entries with type and size', async () => {
    await store.write('alice', 'one.txt', 'short');
    await store.write('alice', 'two.txt', 'longer');
    await store.mkdir('alice', 'sub');
    const entries = (await store.list('alice')).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    expect(entries.map((e) => ({ name: e.name, type: e.type }))).toEqual([
      { name: 'one.txt', type: 'file' },
      { name: 'sub', type: 'directory' },
      { name: 'two.txt', type: 'file' },
    ]);
    const one = entries.find((e) => e.name === 'one.txt')!;
    expect(one.size).toBe(5);
  });

  it('delete is idempotent', async () => {
    await store.delete('alice', 'never.txt');
    await store.write('alice', 'gone.txt', 'x');
    await store.delete('alice', 'gone.txt');
    expect(await store.exists('alice', 'gone.txt')).toBe(false);
  });

  it('append creates the file when missing and concatenates otherwise', async () => {
    await store.append('alice', 'log.txt', 'one\n');
    await store.append('alice', 'log.txt', 'two\n');
    expect(await store.read('alice', 'log.txt')).toBe('one\ntwo\n');
  });

  it('search finds matching lines (literal, case-insensitive)', async () => {
    await store.write('alice', 'a.txt', 'Hello\nWorld\n');
    await store.write('alice', 'sub/b.txt', 'hello again\n');
    const hits = await store.search('alice', 'hello');
    const paths = hits.map((h) => h.path).sort();
    expect(paths).toEqual(['a.txt', 'sub/b.txt']);
  });

  it('rejects path traversal that escapes the agent dir', async () => {
    await expect(
      store.write('alice', '../bob/secret.txt', 'oops'),
    ).rejects.toThrow(/Path traversal/);
  });

  it('readOnly blocks writes', async () => {
    const ro = new SandboxBackedMemoryStore(createHostSandbox(), root, {
      readOnly: true,
    });
    await expect(ro.write('alice', 'x.txt', 'no')).rejects.toThrow(/read-only/);
  });

  it('onBeforeWrite can deny operations', async () => {
    const guarded = new SandboxBackedMemoryStore(createHostSandbox(), root, {
      onBeforeWrite: async (_a, p) => !p.endsWith('.secret'),
    });
    await expect(guarded.write('alice', 'a.secret', 'no')).rejects.toThrow(
      /onBeforeWrite/,
    );
    await guarded.write('alice', 'a.txt', 'yes');
    expect(await guarded.read('alice', 'a.txt')).toBe('yes');
  });

  it('read surfaces non-ENOENT errors instead of masking as File not found', async () => {
    // Read failure due to a string-decoding error (binary content in
    // an encoding the sandbox can't handle) should NOT be mapped to
    // "File not found". Simulate with a stub sandbox that throws a
    // permission-style error.
    const failing = new SandboxBackedMemoryStore(
      {
        // Contract-valid stat: the resolver must be able to attest the path so
        // the read itself is what surfaces the connector's EACCES.
        async stat() {
          return { isSymbolicLink: false } as import('../../src/sandbox/types.js').FileStat;
        },
        async readFile() {
          const e = new Error('EACCES: permission denied');
          (e as NodeJS.ErrnoException).code = 'EACCES';
          throw e;
        },
      } as unknown as SandboxApi,
      root,
    );
    await expect(failing.read('alice', 'x.txt')).rejects.toThrow(/EACCES/);
  });

  it('delete propagates non-not-found errors instead of silently succeeding', async () => {
    // A connector returning a permission error must surface it — the
    // file is still on disk, and reporting "deleted" would be a lie.
    const failing = new SandboxBackedMemoryStore(
      {
        // Same contract-valid stat as the read test above: without it the
        // resolver refuses before delete can surface the connector's error.
        async stat() {
          return { isSymbolicLink: false } as import('../../src/sandbox/types.js').FileStat;
        },
        async rm() {
          const e = new Error('EACCES: permission denied');
          (e as NodeJS.ErrnoException).code = 'EACCES';
          throw e;
        },
      } as unknown as SandboxApi,
      root,
    );
    await expect(failing.delete('alice', 'x.txt')).rejects.toThrow(/EACCES/);
  });

  it('rejects symlink-based escape (Codex P1)', async () => {
    // alice has a symlink "link" → "../bob". Without the canonical
    // containment check, writing to `link/secret.txt` would land in
    // bob's directory.
    await mkdir(path.join(root, 'alice'), { recursive: true });
    await mkdir(path.join(root, 'bob'), { recursive: true });
    await symlink(path.join(root, 'bob'), path.join(root, 'alice', 'link'));

    await expect(
      store.write('alice', 'link/secret.txt', 'pwned'),
    ).rejects.toThrow(/Path traversal via symlink/);

    // Confirm the file did NOT land in bob's directory.
    await expect(store.exists('bob', 'secret.txt')).resolves.toBe(false);
  });

  it('rejects escape through a DANGLING symlink (agent-do-5ww)', async () => {
    // The link's target does not exist yet, so realpath reports ENOENT for the
    // *link*. A resolver that only walks up to the nearest existing ancestor
    // keeps the innocent name and a write lands in bob/ regardless.
    await mkdir(path.join(root, 'alice'), { recursive: true });
    await mkdir(path.join(root, 'bob'), { recursive: true });
    await symlink(path.join(root, 'bob', 'secret.txt'), path.join(root, 'alice', 'dangling'));

    await expect(store.write('alice', 'dangling', 'pwned')).rejects.toThrow(/Path traversal via symlink/);
    await expect(store.exists('bob', 'secret.txt')).resolves.toBe(false);
  });

  it('refuses a symlink cycle rather than returning an uncanonicalised path (agent-do-qhn)', async () => {
    await mkdir(path.join(root, 'alice'), { recursive: true });
    await symlink('loop-b', path.join(root, 'alice', 'loop-a'));
    await symlink('loop-a', path.join(root, 'alice', 'loop-b'));
    await expect(store.write('alice', 'loop-a', 'pwned')).rejects.toThrow(/Path traversal via symlink/);
  });

  it('a connector without realpath still walks: plain paths resolve lexically (agent-do-ws1u)', async () => {
    // Connectors without `realpath` (e.g. just-bash's virtual fs) do NOT get
    // string-only normalisation any more: the stat-based walk runs and ends
    // lexically for genuinely link-free paths.
    const writes: Array<{ path: string; content: string | Uint8Array }> = [];
    const noRealpath = new SandboxBackedMemoryStore(
      {
        async stat() {
          return { isSymbolicLink: false } as import('../../src/sandbox/types.js').FileStat;
        },
        async writeFile(p: string, content: string | Uint8Array) {
          writes.push({ path: p, content });
        },
        async mkdir() {},
      } as unknown as SandboxApi,
      '/work',
    );
    await noRealpath.write('agent1', 'note.txt', 'hi');
    expect(writes[0]?.path).toBe('/work/agent1/note.txt');
  });

  it('a connector reporting not-found by MESSAGE (uncoded) still walks on fresh writes (agent-do-q8hd)', async () => {
    // The contract says stat must fail for a missing path; it does not mandate
    // the Node `code` field. Before the fix, classifyError accepted only
    // code==='ENOENT', so this connector was refused on every fresh write while
    // its ENOENT-coded twin succeeded — the outcome turned on error shape alone.
    const noRealpath = new SandboxBackedMemoryStore(
      {
        async stat(p: string) {
          if (p === '/' || p === '/work' || p === '/work/alice') {
            return { isSymbolicLink: false, isDirectory: true } as import('../../src/sandbox/types.js').FileStat;
          }
          throw new Error("stat: no such file or directory: " + p);
        },
        async writeFile() {},
        async mkdir() {},
      } as unknown as SandboxApi,
      '/work',
    );
    await expect(noRealpath.write('alice', 'note.txt', 'hi')).resolves.toBeUndefined();
  });

  it('an uncoded refusal with the reason AFTER the path still refuses (agent-do-nw7h R1)', async () => {
    // 'stat failed: <path>: no such file' — the phrase follows the path, so any
    // positional head-cut misses it; the phrase-anywhere rule (vetoed only by
    // refusal words) classifies it absent.
    const noRealpath = new SandboxBackedMemoryStore(
      {
        async stat(p: string) {
          if (p === '/' || p === '/work' || p === '/work/alice') {
            return { isSymbolicLink: false, isDirectory: true } as import('../../src/sandbox/types.js').FileStat;
          }
          throw new Error('stat failed: ' + p + ': no such file');
        },
        async writeFile() {},
        async mkdir() {},
      } as unknown as SandboxApi,
      '/work',
    );
    await expect(noRealpath.write('alice', 'note.txt', 'hi')).resolves.toBeUndefined();
  });

  it('a genuine not-found whose PATH contains a veto word still resolves (agent-do-g3ib)', async () => {
    // Mirror of nw7h R2: the veto must not read the echoed path either — a real
    // missing file under '/work/denied-rides/' is absent, not a refusal.
    const noRealpath = new SandboxBackedMemoryStore(
      {
        async stat(p: string) {
          if (p === '/' || p === '/work' || p === '/work/alice') {
            return { isSymbolicLink: false, isDirectory: true } as import('../../src/sandbox/types.js').FileStat;
          }
          throw new Error('stat: no such file or directory: ' + p);
        },
        async writeFile() {},
        async mkdir() {},
      } as unknown as SandboxApi,
      '/work',
    );
    await expect(noRealpath.write('alice', 'denied-rides/secret.txt', 'hi')).resolves.toBeUndefined();
  });

  it('an uncoded refusal with refusal words vetoed even when the path echoes not-found (agent-do-nw7h R2)', async () => {
    // 'prog: <path>: permission denied' with a hostile path: no code, phrase in
    // the path, refusal words in the reason — the veto wins, the walk refuses.
    const noRealpath = new SandboxBackedMemoryStore(
      {
        async stat(p: string) {
          if (p === '/' || p === '/work' || p === '/work/alice') {
            return { isSymbolicLink: false, isDirectory: true } as import('../../src/sandbox/types.js').FileStat;
          }
          throw new Error('prog: ' + p + ': permission denied');
        },
        async writeFile() {},
        async mkdir() {},
      } as unknown as SandboxApi,
      '/work',
    );
    await expect(noRealpath.write('alice', 'not found/secret.txt', 'hi'))
      .rejects.toThrow(/Path traversal via symlink/);
  });

  it('not-found text inside the PATH of an EACCES refusal does not read as absent (agent-do-ql2p)', async () => {
    // The error message echoes the path, and the path is model-controlled: a
    // component named 'not found' inside an ordinary EACCES refusal must stay
    // unattestable — the walk must refuse, not step past a component that exists.
    const writes: Array<{ path: string }> = [];
    const noRealpath = new SandboxBackedMemoryStore(
      {
        async stat(p: string) {
          if (p === '/' || p === '/work' || p === '/work/alice') {
            return { isSymbolicLink: false, isDirectory: true } as import('../../src/sandbox/types.js').FileStat;
          }
          const e = new Error(`EACCES: permission denied, stat '${p}'`);
          (e as NodeJS.ErrnoException).code = 'EACCES';
          throw e;
        },
        async writeFile(p: string) {
          writes.push({ path: p });
        },
        async mkdir() {},
      } as unknown as SandboxApi,
      '/work',
    );
    await expect(noRealpath.write('alice', 'not found/secret.txt', 'hi'))
      .rejects.toThrow(/Path traversal via symlink/);
    expect(writes).toHaveLength(0);
  });

  it('a duck-typed non-Error throw carrying a not-found message is absent too (agent-do-ihxv)', async () => {
    // The same not-found text thrown as a plain { name, message } object must
    // classify the same way as the Error-instance form — the outcome turns on
    // the PHRASE, not the wrapper.
    const noRealpath = new SandboxBackedMemoryStore(
      {
        async stat(p: string) {
          if (p === '/' || p === '/work' || p === '/work/alice') {
            return { isSymbolicLink: false, isDirectory: true } as import('../../src/sandbox/types.js').FileStat;
          }
          throw { name: 'NotFoundError', message: 'no such file or directory: ' + p };
        },
        async writeFile() {},
        async mkdir() {},
      } as unknown as SandboxApi,
      '/work',
    );
    await expect(noRealpath.write('alice', 'note.txt', 'hi')).resolves.toBeUndefined();
  });

  it('an unclassifiable stat error still refuses the walk (fail-closed preserved, agent-do-q8hd)', async () => {
    const noRealpath = new SandboxBackedMemoryStore(
      {
        async stat() {
          const e = new Error('EACCES: permission denied');
          (e as NodeJS.ErrnoException).code = 'EACCES';
          throw e;
        },
        async writeFile() {},
        async mkdir() {},
      } as unknown as SandboxApi,
      '/work',
    );
    await expect(noRealpath.write('alice', 'note.txt', 'hi'))
      .rejects.toThrow(/Path traversal via symlink/);
  });

  it('a connector without realpath but WITH symlink-reporting stat refuses a planted link (agent-do-ws1u)', async () => {
    // agent-do-34f's exact shape, re-closed for the memory store: the connector
    // cannot canonicalise (no `realpath`) but its `stat()` can see the link
    // (just-bash's `[ -L ]`). Judging the alias by its own name let
    // `alias -> ../bob/secret.txt` cross tenants; the walk must refuse it
    // because a link that is visible but unreadable (no `readlink`) is
    // unattested.
    const noRealpath = new SandboxBackedMemoryStore(
      {
        async stat(p: string) {
          if (p.endsWith('/alias')) return { isSymbolicLink: true, isFile: () => false, isDirectory: () => false } as unknown as import('../../src/sandbox/types.js').FileStat;
          return { isSymbolicLink: false, isFile: () => true, isDirectory: () => false } as unknown as import('../../src/sandbox/types.js').FileStat;
        },
        async writeFile() {},
        async mkdir() {},
      } as unknown as SandboxApi,
      '/work',
    );
    await expect(noRealpath.write('alice', 'alias', 'pwned'))
      .rejects.toThrow(/Path traversal via symlink/);
  });
});
