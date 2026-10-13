import { describe, it, expect } from 'vitest';
import { POSIX_PATH_API, realpathSafe, type ResolvedPath } from '../src/stores/sandbox.js';
import type { SandboxApi } from '../src/sandbox/types.js';
import * as nodePath from 'node:path';

/**
 * The complete error-mode matrix for path resolution (agent-do-vn9).
 *
 * Six of the seven findings in this area were one sentence: a catch swallowed a
 * failure it could not classify, and the walk continued as if the component had
 * been attested. Every one of them was caught by a hand-written test for the
 * shape somebody happened to think of, which is why there was always a next
 * round. This file is the table instead: every operation (realpath, stat,
 * readlink) crossed with every outcome, plus the capability combinations and the
 * two bounds. A new error mode is a new row here, not a new review.
 *
 * The rule under test is the invariant: realpathSafe returns ok:true only when
 * every component was positively attested. Anything it cannot classify as
 * "this component is not there yet" is a refusal.
 */

const ROOT = '/ws';
const MISSING = `${ROOT}/a.txt`;

const err = (code: string) => Object.assign(new Error(code), { code });

/** Minimal connector: the resolver only ever calls these three. */
function fake(opts: {
  realpath?: (p: string) => Promise<string>;
  stat?: (p: string) => Promise<{ isSymbolicLink: boolean }>;
  readlink?: (p: string) => Promise<string>;
}): SandboxApi {
  return {
    stat: async () => ({ isFile: false, isDirectory: false, isSymbolicLink: false, size: 0, mtime: new Date() }),
    ...opts,
  } as unknown as SandboxApi;
}

/** Resolves only `resolves`; everything else is ENOENT (a fresh path). */
const realpathUpTo = (resolves: string) => async (p: string) => {
  if (p === resolves) return p;
  throw err('ENOENT');
};

const throwsWith = (e: unknown) => async () => {
  throw e;
};

const notALink = async () => ({ isSymbolicLink: false });
const isLink = async () => ({ isSymbolicLink: true });

const ERRORS: Array<[string, unknown]> = [
  ['EACCES', err('EACCES')],
  ['EPERM', err('EPERM')],
  ['ELOOP', err('ELOOP')],
  ['EIO', err('EIO')],
  ['ENOTDIR', err('ENOTDIR')],
  ['a thrown non-Error', 'boom'],
  ['a thrown null', null],
];

describe('realpathSafe error matrix (agent-do-vn9)', () => {
  // ---- operation x outcome: every non-ENOENT failure refuses ----
  const rows: Array<{
    name: string;
    sandbox: SandboxApi;
    path?: string;
    expect: 'resolved' | 'refused';
    resolvedTo?: string;
  }> = [];

  for (const [label, e] of ERRORS) {
    rows.push({
      name: `realpath throwing ${label} refuses`,
      sandbox: fake({ realpath: throwsWith(e) as (p: string) => Promise<string> }),
      expect: 'refused',
    });
    rows.push({
      name: `stat throwing ${label} refuses (shares no catch with readlink)`,
      sandbox: fake({ realpath: realpathUpTo(ROOT), stat: throwsWith(e) as never }),
      expect: 'refused',
    });
    rows.push({
      name: `readlink throwing ${label} on an identified link refuses`,
      sandbox: fake({ realpath: realpathUpTo(ROOT), stat: isLink, readlink: throwsWith(e) as never }),
      expect: 'refused',
    });
  }

  // ENOENT is the only "absent": the walk may step past it.
  rows.push({
    name: 'ENOENT everywhere below an existing root still resolves',
    sandbox: fake({ realpath: realpathUpTo(ROOT), stat: throwsWith(err('ENOENT')) as never }),
    expect: 'resolved',
    resolvedTo: MISSING,
  });
  rows.push({
    name: 'stat reporting not-a-link resolves',
    sandbox: fake({ realpath: realpathUpTo(ROOT), stat: notALink }),
    expect: 'resolved',
    resolvedTo: MISSING,
  });
  rows.push({
    name: 'a realpath that answers resolves through it',
    sandbox: fake({ realpath: async (p) => p, stat: notALink }),
    expect: 'resolved',
    resolvedTo: MISSING,
  });
  rows.push({
    name: 'a link whose target is read is followed',
    sandbox: fake({
      realpath: realpathUpTo(`${ROOT}/real.txt`),
      stat: isLink,
      readlink: async () => `${ROOT}/real.txt`,
    }),
    path: `${ROOT}/link.txt`,
    expect: 'resolved',
    resolvedTo: `${ROOT}/real.txt`,
  });

  // A connector that answers with something other than a path cannot be trusted.
  rows.push({
    name: 'realpath answering with a non-string refuses',
    sandbox: fake({ realpath: (async () => undefined) as never, stat: notALink }),
    expect: 'refused',
  });
  rows.push({
    name: 'readlink answering with a non-string refuses',
    sandbox: fake({
      realpath: realpathUpTo(ROOT),
      stat: isLink,
      readlink: (async () => undefined) as never,
    }),
    expect: 'refused',
  });
  rows.push({
    name: 'stat answering with a malformed entry refuses rather than crashing',
    sandbox: fake({ realpath: realpathUpTo(ROOT), stat: (async () => undefined) as never }),
    expect: 'refused',
  });

  // ---- capability combinations (the contract's optional primitives) ----
  rows.push({
    name: 'no realpath but a readlink refuses (cannot expand what it can see)',
    sandbox: fake({ stat: isLink, readlink: async () => '/etc/passwd' }),
    expect: 'refused',
  });
  rows.push({
    name: 'neither primitive resolves lexically (declares it has no symlinks)',
    sandbox: fake({}),
    expect: 'resolved',
    resolvedTo: MISSING,
  });
  rows.push({
    name: 'a link with no readlink capability refuses',
    sandbox: fake({ realpath: realpathUpTo(ROOT), stat: isLink }),
    expect: 'refused',
  });

  // ---- the shipped connectors' shapes (agent-do-34f) ----
  rows.push({
    name: 'a connector that reports links but has no primitives refuses them (just-bash shape)',
    // wrapJustBashSandbox detects symlinks via [ -L ] in stat, yet exposes neither
    // realpath nor readlink. The absence of both must not be read as "no symlinks".
    sandbox: fake({ stat: isLink }),
    expect: 'refused',
  });
  rows.push({
    name: 'the same connector still resolves an ordinary path (no-primitive control)',
    sandbox: fake({ stat: notALink }),
    expect: 'resolved',
    resolvedTo: MISSING,
  });
  rows.push({
    name: 'the same connector refuses a symlinked directory component',
    // The link is an ancestor, not the leaf: every component must be inspected,
    // not just the one the caller named.
    sandbox: fake({
      stat: (async (p: string) => ({ isSymbolicLink: p === '/ws/alias' })) as never,
    }),
    path: '/ws/alias/hooks/planted',
    expect: 'refused',
  });

  // ---- bounds ----
  rows.push({
    name: 'an unresolvable root refuses',
    sandbox: fake({ realpath: throwsWith(err('ENOENT')) as never, stat: throwsWith(err('ENOENT')) as never }),
    expect: 'refused',
  });

  it.each(rows)('$name', async (row) => {
    const result = await realpathSafe(row.sandbox, row.path ?? MISSING, POSIX_PATH_API);
    if (row.expect === 'refused') {
      expect(result.ok).toBe(false);
      expect((result as Extract<ResolvedPath, { ok: false }>).reason).toBe('unresolved-path');
      // the shape a caller must never receive instead of a refusal
      expect(result).not.toHaveProperty('path');
    } else {
      expect(result.ok).toBe(true);
      expect((result as Extract<ResolvedPath, { ok: true }>).path).toBe(row.resolvedTo);
    }
  });

  it('refuses a symlink chain longer than the hop budget', async () => {
    const linkAt = async (p: string) => `c${Number(p.slice(2)) + 1}`;
    const result = await realpathSafe(
      fake({ realpath: throwsWith(err('ENOENT')) as never, stat: isLink, readlink: linkAt }),
      '/c0',
      POSIX_PATH_API,
    );
    expect(result.ok).toBe(false);
  });
});

describe('POSIX_PATH_API matches node:path.posix on the shapes the resolver uses', () => {
  // The adapter is hand-written because this module deliberately has no Node
  // import, so it is checked against the reference implementation rather than
  // against my reasoning. Hand-rolled path arithmetic produces exactly the edge
  // cases that bit the resolver at the root during agent-do-vn9.
  const paths = ['/', '/ws', '/ws/a', '/ws/a/b.txt', 'ws', 'ws/a', '.', '', '/ws/../etc', 'a/./b'];

  it('join', () => {
    for (const a of paths) {
      for (const b of ['', 'x', '/y', '..', '../z', 'ws/a']) {
        expect(POSIX_PATH_API.join(a, b), `join(${JSON.stringify(a)}, ${JSON.stringify(b)})`).toBe(
          nodePath.posix.join(a, b),
        );
      }
    }
  });

  it('dirname', () => {
    for (const a of paths) {
      expect(POSIX_PATH_API.dirname(a), `dirname(${JSON.stringify(a)})`).toBe(nodePath.posix.dirname(a));
    }
  });

  it('relative', () => {
    for (const a of ['/', '/ws', '/ws/a', '/a/b']) {
      for (const b of ['/', '/ws', '/ws/a', '/ws/a/b.txt', '/etc/x', '/a/c']) {
        expect(POSIX_PATH_API.relative(a, b), `relative(${a}, ${b})`).toBe(nodePath.posix.relative(a, b));
      }
    }
  });

  it('isAbsolute', () => {
    for (const a of paths) {
      expect(POSIX_PATH_API.isAbsolute(a)).toBe(nodePath.posix.isAbsolute(a));
    }
  });
});
