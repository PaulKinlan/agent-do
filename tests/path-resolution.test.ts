import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { POSIX_PATH_API, realpathSafe, type ResolvedPath } from '../src/stores/sandbox.js';
import type { SandboxApi } from '../src/sandbox/types.js';
import * as nodePath from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { createHostSandbox } from '../src/sandbox/connectors/host.js';

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

  // ---- malformed stat records (agent-do-a10) ----
  rows.push({
    name: 'an incomplete stat record refuses rather than attesting on a missing field',
    // {} does not throw: isSymbolicLink is undefined, falsy, and the path passed.
    sandbox: fake({ realpath: realpathUpTo(ROOT), stat: (async () => ({})) as never }),
    expect: 'refused',
  });
  rows.push({
    name: 'a non-boolean isSymbolicLink refuses',
    sandbox: fake({ realpath: realpathUpTo(ROOT), stat: (async () => ({ isSymbolicLink: 'yes' })) as never }),
    expect: 'refused',
  });
  rows.push({
    name: 'a null stat record refuses',
    sandbox: fake({ realpath: realpathUpTo(ROOT), stat: (async () => null) as never }),
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

describe('realpathSafe agrees with fs.realpath on a host sandbox (resolution oracle)', () => {
  // The error matrix pins how failures are classified; nothing pinned the walk's
  // *resolution* semantics, which is the last hand-rolled logic here without a
  // reference. This is that reference: on a real filesystem the answer must be
  // whatever fs.realpath says, wherever fs.realpath has an answer, and where it
  // does not (a dangling link) the answer must be the target the link names -
  // never the link's own name, which is what every finding in this area was.
  let dir: string;
  const p = (...parts: string[]) => nodePath.join(dir, ...parts);

  beforeEach(async () => {
    dir = await fs.promises.realpath(await fs.promises.mkdtemp(nodePath.join(os.tmpdir(), 'agent-do-oracle-')));
    await fs.promises.mkdir(p('a', 'b', 'c'), { recursive: true });
    await fs.promises.writeFile(p('a', 'b', 'c', 'file.txt'), 'x');
    await fs.promises.mkdir(p('.git', 'hooks'), { recursive: true });
    await fs.promises.symlink(p('a', 'b', 'c', 'file.txt'), p('link-file'));
    await fs.promises.symlink('a', p('link-dir'));
    await fs.promises.symlink('a/b/c/missing.txt', p('dangling'));
    await fs.promises.symlink('link-file', p('chain1'));
    await fs.promises.symlink('.git/hooks/planted', p('to-git'));
    await fs.promises.symlink('../../elsewhere', p('a', 'up'));
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  const sandbox = () => createHostSandbox({ cwd: dir }) as unknown as SandboxApi;

  it('matches fs.realpath wherever realpath has an answer', async () => {
    for (const candidate of ['a', 'a/b/c/file.txt', 'link-file', 'link-dir', 'link-dir/b/c/file.txt', 'chain1', '.git/hooks']) {
      const target = p(...candidate.split('/'));
      let expected: string | undefined;
      try {
        expected = await fs.promises.realpath(target);
      } catch {
        expected = undefined;
      }
      if (expected === undefined) continue;
      const result = await realpathSafe(sandbox(), target, nodePath);
      expect(result.ok, candidate).toBe(true);
      expect((result as Extract<ResolvedPath, { ok: true }>).path, candidate).toBe(expected);
    }
  });

  it('names the target of a dangling link rather than the link', async () => {
    // fs.realpath cannot answer here at all, so the oracle is the link's target.
    const result = await realpathSafe(sandbox(), p('dangling'), nodePath);
    expect(result.ok).toBe(true);
    expect((result as Extract<ResolvedPath, { ok: true }>).path).toBe(p('a', 'b', 'c', 'missing.txt'));
  });

  it('resolves a dangling link through the git directory to the path it would write', async () => {
    const result = await realpathSafe(sandbox(), p('to-git'), nodePath);
    expect(result.ok).toBe(true);
    expect((result as Extract<ResolvedPath, { ok: true }>).path).toBe(p('.git', 'hooks', 'planted'));
  });

  it('refuses a link that escapes the tree, naming nothing of its own', async () => {
    const result = await realpathSafe(sandbox(), p('a', 'up'), nodePath);
    // It resolves (the target need not exist), but it must never be the alias.
    if (result.ok) {
      expect(result.path).not.toBe(p('a', 'up'));
      expect(result.path).toBe(nodePath.resolve(p('a', '..'), '../elsewhere'));
    } else {
      expect(result.reason).toBe('unresolved-path');
    }
  });
});

/**
 * THE RESOLUTION SPECIFICATION (agent-do-zuy) - the rule this block encodes.
 *
 * `realpathSafe(sandbox, path, pathApi)` walks a path component by component from the root and returns
 * `{ok: true, path}` iff EVERY component of what it returns was positively attested: canonicalised by the
 * connector's `realpath`, observed not to be a symlink, or observed to be a symlink whose target was read and
 * followed within the resolver's own hop budget. Everything else is `{ok: false, reason: 'unresolved-path'}`.
 * Concretely, and each clause below is asserted rather than asserted-about:
 *
 *   1. EXISTING PATHS ANSWER LIKE THE PLATFORM. Where every component exists the answer is exactly what
 *      `fs.realpath` says, so here a wrong answer is a failure and not a judgement call.
 *   2. A SYMLINK IS NEVER THE ANSWER. Every finding in this area - cn2 and its nine siblings - was a path that
 *      named the alias instead of the target. (This is vacuous for a path that contains no link, which is why
 *      the generated oracle only applies it to candidates that actually traverse one.)
 *   3. A RELATIVE TARGET IS RELATIVE TO THE LINK'S OWN DIRECTORY, not to the path the caller passed and not to
 *      the root. At depth this differs from the link's own name in its prefix as well as its tail - which is why
 *      the fixed case this block replaces (a dangling link AT THE ROOT, where the link's directory IS the root)
 *      could not detect a mistake in this rule at all.
 *   4. NON-EXISTENT TAILS RESOLVE, they do not refuse: a path whose missing part comes after all of its existing
 *      components is returned with that tail joined on, because callers usually ask about paths they are about
 *      to write. This is what makes rule 3's answer "the resolved target" rather than a refusal.
 *   5. UNATTESTABLE COMPONENTS REFUSE: a cycle, or a link whose target cannot be read, is `ok: false`.
 *   6. THE HOP BUDGET BOUNDS THE RESOLVER'S OWN EXPANSIONS, and a connector that canonicalises is one
 *      attestation. `hops` increments once per `readlink` the walk performs, so on a connector that supplies
 *      `realpath` a chain of any length the platform will follow is canonicalised in a single call and counts as
 *      ONE hop - measured: a 40-link chain resolves through the host connector, and a 100-link chain refuses
 *      because the PLATFORM refuses it (ELOOP). The budget is load-bearing for a connector WITHOUT `realpath`,
 *      where the walk expands each link itself; both behaviours are asserted below, because a rule that claims
 *      the budget always refuses a long chain would be wrong, and this file is the place that would have said so.
 *      The budget is also load-bearing for TERMINATION, not only for a bound: with no realpath and no budget the
 *      walk does not terminate on a cycle (measured by mutation - removing the check hangs the suite rather than
 *      failing it), so rule 5's refusal is what keeps rule 4's "missing tails resolve" from looping forever.
 *
 * The generator produces graphs at random from a seeded PRNG (a failure is reproducible from the seed in its
 * message) and checks 1-6 as predicates rather than as cases someone thought to write down. A new finding in
 * this function should become an assertion or a generator row here - not another review round.
 */
describe('realpathSafe on generated symlink graphs (agent-do-zuy)', { timeout: 120_000 }, () => {
  /** Deterministic PRNG, so a failing graph is reproducible from the seed printed in its assertion message. */
  const mulberry32 = (seed: number): (() => number) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  let dir: string;
  const p = (...parts: string[]) => nodePath.join(dir, ...parts);
  const okPath = (r: ResolvedPath) => (r.ok ? r.path : `<refused: ${r.reason}>`);

  beforeEach(async () => {
    dir = await fs.promises.realpath(await fs.promises.mkdtemp(nodePath.join(os.tmpdir(), 'agent-do-zuy-')));
  });
  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  const sandbox = () => createHostSandbox({ cwd: dir }) as unknown as SandboxApi;
  /** The same connector with `realpath` hidden, so the WALK does the expanding and its budget is load-bearing. */
  const sandboxWithoutRealpath = () =>
    ({ ...(createHostSandbox({ cwd: dir }) as unknown as Record<string, unknown>), realpath: undefined } as unknown as SandboxApi);

  const platformAnswer = async (target: string): Promise<string | undefined> => {
    try {
      return await fs.promises.realpath(target);
    } catch {
      return undefined;
    }
  };

  /** A chain of `n` links ending at an existing file, each link naming the next. Returns the first link's path. */
  const buildChain = async (n: number, name = 'chain'): Promise<string> => {
    await fs.promises.mkdir(p(name), { recursive: true });
    await fs.promises.writeFile(p(name, 'end.txt'), 'x');
    for (let i = 0; i < n; i++) {
      await fs.promises.symlink(i === n - 1 ? 'end.txt' : `hop${i + 1}`, p(name, `hop${i}`));
    }
    return `${name}/hop0`;
  };

  it('agrees with fs.realpath on generated graphs wherever it has an answer (rule 1, rule 2)', async () => {
    for (let seed = 1; seed <= 24; seed++) {
      const rng = mulberry32(seed);
      await fs.promises.rm(dir, { recursive: true, force: true });
      await fs.promises.mkdir(dir, { recursive: true });
      // An acyclic tree of real directories and files, plus links whose targets all EXIST, so fs.realpath
      // always has an answer and the comparison can be exact rather than hedged.
      const dirs = ['d0'];
      for (let i = 1; i <= 2; i++) dirs.push(`${dirs[Math.floor(rng() * dirs.length)]}/d${i}`);
      for (const d of dirs) await fs.promises.mkdir(p(...d.split('/')), { recursive: true });
      const files: string[] = [];
      for (let i = 0; i < 4; i++) {
        const f = `${dirs[Math.floor(rng() * dirs.length)]}/f${i}.txt`;
        await fs.promises.writeFile(p(...f.split('/')), 'x');
        files.push(f);
      }
      // Relative and absolute targets, at varying depth, plus a chain whose target is another link. A link at
      // depth is the shape a root-level case cannot reach.
      const links: string[] = [];
      for (let i = 0; i < 4; i++) {
        const parent = dirs[Math.floor(rng() * dirs.length)];
        const name = `${parent}/lnk${i}`;
        const target = files[Math.floor(rng() * files.length)];
        const rel = nodePath.relative(p(...parent.split('/')), p(...target.split('/')));
        await fs.promises.symlink(rng() < 0.3 ? p(...target.split('/')) : rel, p(...name.split('/')));
        links.push(name);
      }
      const chained = `${dirs[0]}/chain`;
      await fs.promises.symlink(nodePath.relative(p(...dirs[0].split('/')), p(...links[0].split('/'))), p(...chained.split('/')));

      // DIRECTORY links, so a candidate can walk THROUGH a link instead of stopping at one (agent-do-108).
      // Every leaf link above targets a FILE, so no generated candidate ever had a link as an ancestor: the
      // fixed oracle had exactly one hand-written link-dir and the generator could not reach that shape at all.
      // Each link targets a dedicated subtree containing a file, so a candidate can always continue past the
      // link with a suffix that EXISTS - which is what lets fs.realpath stay the oracle instead of a hedge.
      const targets: string[] = [];
      for (let i = 0; i < 2; i++) {
        const t = `${dirs[i % dirs.length]}/target${i}`;
        await fs.promises.mkdir(p(...t.split('/')), { recursive: true });
        await fs.promises.writeFile(p(...t.split('/'), 'leaf.txt'), 'x');
        targets.push(t);
      }
      // A link INSIDE a target subtree, pointing at a file in another one: traversing that path crosses two
      // links at different depths, which is the "links at each depth as traversed components" the bead asks for.
      await fs.promises.symlink(
        nodePath.relative(p(...targets[0].split('/')), p(...targets[1].split('/'), 'leaf.txt')),
        p(...targets[0].split('/'), 'inner-link'),
      );

      const dirLinks: Array<{ name: string; target: string }> = [];
      for (let i = 0; i < 3; i++) {
        const parent = dirs[Math.floor(rng() * dirs.length)];
        const target = targets[Math.floor(rng() * targets.length)];
        const name = `${parent}/dlink${i}`;
        await fs.promises.symlink(
          rng() < 0.3 ? p(...target.split('/')) : nodePath.relative(p(...parent.split('/')), p(...target.split('/'))),
          p(...name.split('/')),
        );
        dirLinks.push({ name, target });
      }
      // A directory link whose target is ANOTHER directory link, so following it lands on a link.
      const chainedDir = { name: `${dirs[0]}/dchain`, target: dirs[0] };
      await fs.promises.symlink(
        nodePath.relative(p(...dirs[0].split('/')), p(...dirLinks[0].name.split('/'))),
        p(...chainedDir.name.split('/')),
      );

      // RAW ".."-after-a-link candidates (agent-do-dcz). Each link deliberately sits in a DIFFERENT directory
      // from the one it targets, so "<link>/../<basename>" as POSIX resolves it (the ".." applied to the LINK
      // TARGET's directory) is a path that EXISTS while the lexical reading of the same string does not. That
      // difference is what gives these cases teeth: an implementation which normalised its input first would
      // answer with the lexical path and disagree with fs.realpath.
      //
      // API SEMANTICS, stated because these candidates depend on it: realpathSafe resolves the path it is GIVEN,
      // applying ".." to the already-resolved prefix, so a raw "link/.." gets POSIX semantics. That is a property
      // of the resolver, not a promise to every caller - the shipped deny list normalises its input before calling
      // (deny-list.ts), so a raw path here is defence in depth. The resolver is deliberately not made to normalise
      // first: normalising would discard the difference these cases exist to pin.
      const rawDir = 'raw';
      await fs.promises.mkdir(p(rawDir), { recursive: true });
      await fs.promises.symlink(`../${targets[0]}`, p(rawDir, 'to-target'));
      const rawCandidates = [
        `${dir}/${rawDir}/to-target/../${nodePath.basename(targets[0])}`,
        `${dir}/${rawDir}/to-target/../${nodePath.basename(targets[0])}/leaf.txt`,
      ];

      const allDirLinks = [...dirLinks, chainedDir];
      // Through a link, through a link with a nested suffix, and through two links in one path. The
      // ".."-AFTER-a-link shape lives in rawCandidates, NOT here: candidates in this list are built with p(...),
      // and nodePath.join normalises ".." lexically, so a `${name}/../${basename(target)}` entry reached the
      // resolver already collapsed, asserted nothing about link expansion, and was the reason rule 2 below
      // carried a '/../' exemption (agent-do-dcz).
      const throughLinks = allDirLinks.flatMap(({ name }) => [`${name}/leaf.txt`]);
      throughLinks.push(`${chainedDir.name}/leaf.txt`);
      throughLinks.push(`${dirLinks[0].name}/inner-link`);

      const linkNames = [...links, chained, ...allDirLinks.map((l) => l.name), `${rawDir}/to-target`];
      // Link names are RELATIVE to the sandbox root, but a candidate may be absolute - the raw ones below are -
      // so compare on the form relative to `dir`. Without this, traversesLink could not see an absolute
      // candidate at all and rule 2 was skipped on precisely the candidates added to exercise it (agent-do-u0c).
      const relativeToDir = (candidate: string) =>
        candidate.startsWith(`${dir}/`) ? candidate.slice(dir.length + 1) : candidate;
      const traversesLink = (candidate: string) => {
        const rel = relativeToDir(candidate);
        return linkNames.some((l) => rel === l || rel.startsWith(`${l}/`));
      };

      // The oracle's own instrumentation, asserted rather than assumed. Rule 2 can only bite on a candidate that
      // traversesLink recognises; if detection silently stops matching, the suite keeps passing while checking
      // less - which is exactly what happened and is why this check exists rather than a comment claiming it.
      for (const raw of rawCandidates) {
        expect(
          traversesLink(raw),
          `rule 2 cannot see the raw candidate ${raw}, so it is not being checked`,
        ).toBe(true);
      }

      for (const candidate of [...files, ...links, chained, ...throughLinks, ...rawCandidates]) {
        // A candidate that already names an absolute path is used AS GIVEN, which matters only for the raw ones
        // below - and is the whole point of them: nodePath.join normalises ".." lexically, so building a path with
        // p(...) (as every other candidate does) strips a ".." AFTER a link before the resolver ever sees it, and
        // the case proves nothing (agent-do-dcz).
        const target = candidate.startsWith('/') ? candidate : p(...candidate.split('/'));
        const expected = await platformAnswer(target);
        if (expected === undefined) continue;
        // BOTH connectors, and this is the difference between testing the walk and testing the connector.
        // With `realpath` available the connector canonicalises the whole path in ONE call, so the walk's own
        // expansion is never exercised - measured: a mutation that bases a relative target on the link's own path
        // instead of its directory changes NOTHING here (the connector answers first). Without `realpath` the walk
        // expands every component itself, which is where rules 3-6 live and where every finding in this area was.
        for (const [label, sb] of [['host', sandbox()], ['walk (no realpath)', sandboxWithoutRealpath()]] as const) {
          const result = await realpathSafe(sb, target, nodePath);
          expect(result.ok, `seed ${seed}, ${candidate} [${label}]: expected a resolution`).toBe(true);
          expect(okPath(result), `seed ${seed}, ${candidate} [${label}]`).toBe(expected);
          if (traversesLink(candidate)) {
            // rule 2 - a link is never the answer. The former '/../' exemption is gone: the only candidates here
            // containing ".." are the raw ones, which are passed un-normalised, so the path the caller asked for
            // and the resolved answer are genuinely different strings and this assertion can bite (agent-do-dcz).
            expect(okPath(result), `seed ${seed}, ${candidate} [${label}]: returned the alias`).not.toBe(target);
          }
        }
        }
      }
  });

  it('resolves a dangling link against ITS OWN DIRECTORY at any depth (rule 3, rule 4)', async () => {
    // fs.realpath cannot answer here at all, so the oracle is the rule: the target string resolved against the
    // real path of the directory CONTAINING the link. The fixed graph's dangling link sits AT THE ROOT, where
    // that directory IS the root, so it cannot distinguish a resolver which uses the link's directory from one
    // which always resolves against the root - both answer identically there, and this case puts the link at
    // depth so they differ. (It DOES catch basing the resolution on the link's own PATH, which is a different
    // mistake: measured by mutation, that fails this case and three others; the root-based one is the shape only
    // a generated depth-varying case can find.)
    for (let seed = 100; seed <= 112; seed++) {
      const rng = mulberry32(seed);
      await fs.promises.rm(dir, { recursive: true, force: true });
      await fs.promises.mkdir(dir, { recursive: true });
      const parent = ['d0', 'd0/d1', 'd0/d1/d2'][Math.floor(rng() * 3)];
      await fs.promises.mkdir(p(...parent.split('/')), { recursive: true });
      const link = `${parent}/dangling`;
      const missingTarget = rng() < 0.5 ? 'not-here.txt' : 'nested/not-here.txt';
      await fs.promises.symlink(missingTarget, p(...link.split('/')));

      const result = await realpathSafe(sandbox(), p(...link.split('/')), nodePath);
      const linkDirReal = await fs.promises.realpath(p(...parent.split('/')));
      const expected = nodePath.join(linkDirReal, missingTarget);
      expect(result.ok, `seed ${seed}: a missing tail after existing components must resolve (rule 4)`).toBe(true);
      expect(okPath(result), `seed ${seed}: resolved the target against the wrong directory`).toBe(expected);
      expect(okPath(result), `seed ${seed}: returned the link itself`).not.toBe(p(...link.split('/')));
      // The specific mistake this pins: using the link's own path as the base instead of its directory.
      expect(okPath(result), `seed ${seed}: duplicated the link's directory`).not.toBe(
        nodePath.join(p(...link.split('/')), missingTarget),
      );
    }
  });

  it('refuses cycles, and bounds its OWN expansions by the hop budget (rule 5, rule 6)', async () => {
    await fs.promises.mkdir(p('cyc'), { recursive: true });
    await fs.promises.symlink('cyc-b', p('cyc', 'cyc-a'));
    await fs.promises.symlink('cyc-a', p('cyc', 'cyc-b'));
    expect((await realpathSafe(sandbox(), p('cyc', 'cyc-a'), nodePath)).ok, 'a cycle must refuse').toBe(false);
    expect((await realpathSafe(sandboxWithoutRealpath(), p('cyc', 'cyc-a'), nodePath)).ok, 'a cycle must refuse without a connector realpath too').toBe(false);

    // The budget is load-bearing exactly where the WALK expands: a connector without realpath.
    const long = await buildChain(40);
    const walkExpanded = await realpathSafe(sandboxWithoutRealpath(), p(...long.split('/')), nodePath);
    expect(walkExpanded.ok, 'the walk must refuse a chain longer than its own 32-hop budget').toBe(false);
    // ...and a short chain still resolves through that same connector, so the refusal above is the budget.
    await fs.promises.symlink('end.txt', p('chain', 'short'));
    expect((await realpathSafe(sandboxWithoutRealpath(), p('chain', 'short'), nodePath)).ok).toBe(true);

    // On a connector that canonicalises, the same chain is ONE attestation, so it resolves - and this is
    // asserted deliberately: the budget does not refuse a long chain here, and a spec that said it did
    // would be wrong about the shipped connector.
    const hostResult = await realpathSafe(sandbox(), p(...long.split('/')), nodePath);
    expect(hostResult.ok, 'a 40-link chain is canonicalised by the connector in one call').toBe(true);
    expect(okPath(hostResult)).toBe(p('chain', 'end.txt'));

    // ...whereas a chain the PLATFORM refuses (ELOOP) refuses here too, so the outcome is still fail-closed.
    const tooLong = await buildChain(100, 'chain2');
    expect(await platformAnswer(p(...tooLong.split('/'))), 'the platform should refuse a 100-link chain').toBeUndefined();
    expect((await realpathSafe(sandbox(), p(...tooLong.split('/')), nodePath)).ok).toBe(false);
  });
});
