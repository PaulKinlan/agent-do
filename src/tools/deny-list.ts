/**
 * Workspace deny list — path-scoped access policy for file tools.
 *
 * Workspace tools are rooted at a working directory, and by default they
 * can touch anything under it (see H-04 in the security audit). That's
 * right for day-to-day code-review agents, but `.env`, `.ssh/*`,
 * `.git/hooks/*`, and `node_modules/*` are common footguns. This module
 * centralises the policy:
 *
 *   - a small opinionated default deny list (secrets + credential material
 *     for reads, all of the above plus `node_modules` + `.git/**` for
 *     writes);
 *   - optional `.agent-doignore` at the workspace root, gitignore-style,
 *     merged on top of the defaults;
 *   - caller-supplied extra patterns from `--exclude <glob>`;
 *   - an explicit `--include-sensitive` escape hatch for users who want
 *     the old fully-open behaviour (declared, not accidental).
 *
 * The guard returns structured results that integrate with the
 * `ToolResult` flow: blocked reads / writes produce
 * `{ blocked: true, reason: 'deny-list', rule, path }`. The matched rule
 * appears in the user summary (so operators can debug) but is withheld
 * from `modelContent` — small defence against the model probing the
 * policy via trial and error.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { ToolResult } from './types.js';
import type { SandboxApi } from '../sandbox/types.js';
import { realpathSafe } from '../stores/sandbox.js';
import { createHostSandbox } from '../sandbox/connectors/host.js';

/**
 * Default read deny list. Secrets and credential material. `.git/objects`
 * would leak repo internals; leave `.git/HEAD` readable so the agent can
 * identify the branch.
 */
export const DEFAULT_READ_DENY: readonly string[] = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  'id_rsa',
  'id_rsa.*',
  'id_ed25519',
  'id_ed25519.*',
  '.ssh/**',
  '.aws/**',
  '.gcloud/**',
  '.kube/**',
  '.git/objects/**',
  '.git/hooks/**',
];

/**
 * Default write deny list. Everything on the read list plus things we
 * don't want the agent silently mutating: `.git/**` (branches, config,
 * hooks); `node_modules/**` (malware persistence surface, also clobbered
 * by `npm install`).
 */
export const DEFAULT_WRITE_DENY: readonly string[] = [
  ...DEFAULT_READ_DENY,
  '.git/**',
  'node_modules/**',
];

/** Filename used for project-scoped ignore rules, layered on the defaults. */
export const AGENT_DO_IGNORE_FILE = '.agent-doignore';

export interface DenyGuardOptions {
  /** Extra patterns to add (e.g. from `--exclude`). */
  extra?: readonly string[];
  /**
   * Bypass the built-in sensitive-file defaults, and reopen a symlink that
   * resolves outside the workspace (otherwise blocked as
   * `outside-workspace`). The `extra` patterns and any `.agent-doignore`
   * rules still apply. Use only when the user has explicitly opted in via
   * `--include-sensitive`.
   */
  includeSensitive?: boolean;
  /**
   * Skip reading a `.agent-doignore` file at the workspace root. Default
   * behaviour reads one if present. Primarily for tests.
   */
  skipAgentDoIgnore?: boolean;
  /**
   * Substrate the workspace lives on. When set, policy canonicalisation runs
   * through the substrate's own `realpath` instead of the host filesystem,
   * which cannot see a virtual workspace at all (agent-do-kov): a symlink the
   * substrate resolves would otherwise be judged by the host and skipped.
   */
  sandbox?: SandboxApi;
}

export interface DenyDecision {
  blocked: boolean;
  /** The pattern that matched, if any. Safe to show the operator. */
  rule?: string;
}

export interface DenyGuard {
  checkRead(relPath: string): Promise<DenyDecision>;
  checkWrite(relPath: string): Promise<DenyDecision>;
  /**
   * Filter a list of relative paths down to ones that are *at least*
   * readable. Used by grep/find to hide denied entries from results.
   */
  filterReadable<T extends { path: string }>(items: T[]): Promise<T[]>;
}

/** Rule reported when a path is inside the workspace lexically but resolves outside it. */
const OUTSIDE_WORKSPACE_RULE = 'outside-workspace';

type CanonicalPath = { rel: string } | { escape: true } | { outside: true };

/** True when `rel` is the parent directory itself, not merely a name starting with dots. */
function isParentSegment(rel: string, sep: string): boolean {
  return rel === '..' || rel.startsWith('..' + sep);
}

/**
 * Resolve a caller-supplied path before any rule is evaluated, through **the
 * substrate the workspace lives on** — one implementation for host workspaces
 * and sandbox-backed ones alike.
 *
 * The policy used to run on the raw model string and four shapes got past it,
 * each found in review:
 *   - a legal `foo/../.env` hit the old `rel.includes('..')` bail-out
 *     (agent-do-cn2);
 *   - an in-workspace symlink to `.env` matched no glob, because every rule is
 *     workspace-relative (agent-do-cn2);
 *   - canonicalising with the *host* filesystem resolved nothing for a virtual
 *     root such as `/virtual-cn2-workspace`, so a substrate-only symlink kept
 *     its innocent name (agent-do-kov);
 *   - a not-yet-existing leaf was returned raw, so a fresh write through a
 *     symlinked directory landed in `.git/hooks` (agent-do-ro9).
 *
 * Fixing those one at a time is what showed the resolver itself was the defect:
 * there were two of them and they disagreed. So there is now exactly one, shared
 * with the store's containment check — `realpathSafe`, which also follows a
 * symlink whose target does not exist yet by lstat/readlink (agent-do-5ww). Only
 * the path flavour differs: a virtual root is POSIX, the host follows the OS.
 *
 * Lexical containment is checked first, because the store's traversal guard owns
 * that case and still refuses it. Returns the workspace-relative canonical path
 * for matching, or the reason no workspace-relative glob can describe it.
 */
async function canonicalise(
  substrate: SandboxApi,
  pathApi: typeof path,
  rootPath: string,
  relPath: string,
): Promise<CanonicalPath> {
  const abs = pathApi.resolve(rootPath, relPath);
  const lexical = pathApi.relative(rootPath, abs);
  if (isParentSegment(lexical, pathApi.sep) || pathApi.isAbsolute(lexical)) {
    return { escape: true };
  }
  const real = await realpathSafe(substrate, abs);
  const realRoot = await realpathSafe(substrate, rootPath);
  const realRel = pathApi.relative(realRoot, real);
  if (isParentSegment(realRel, pathApi.sep) || pathApi.isAbsolute(realRel)) {
    return { outside: true };
  }
  return { rel: normaliseRel(realRel) };
}

/**
 * Build a DenyGuard for a workspace rooted at `workingDir`.
 */
export function createDenyGuard(
  workingDir: string,
  options: DenyGuardOptions = {},
): DenyGuard {
  const readBase = options.includeSensitive ? [] : [...DEFAULT_READ_DENY];
  const writeBase = options.includeSensitive ? [] : [...DEFAULT_WRITE_DENY];
  const extra = options.extra ?? [];
  const ignorePatterns = options.skipAgentDoIgnore
    ? []
    : readAgentDoIgnore(workingDir);

  const readRules = [...readBase, ...extra, ...ignorePatterns];
  const writeRules = [...writeBase, ...extra, ...ignorePatterns];

  const readIg: Ignore = ignore().add(readRules);
  const writeIg: Ignore = ignore().add(writeRules);

  // One substrate and one resolver. For a host workspace the substrate *is* the
  // host filesystem, so it goes through createHostSandbox rather than getting a
  // second host-specific resolver — the drift between two of those is exactly
  // what produced agent-do-ro9 and agent-do-5ww.
  const substrate: SandboxApi = options.sandbox ?? createHostSandbox({ cwd: workingDir });
  const pathApi = options.sandbox ? path.posix : path;
  const rootPath = pathApi.resolve(workingDir);

  /**
   * Canonicalise, then either hand back the relative path for glob matching or
   * a decided answer. Lexically escaping paths stay policy-clean because the
   * store's traversal guard reports them and always has; a path that resolves
   * outside the workspace through a symlink is blocked, since no
   * workspace-relative rule can express it - unless the operator opted into
   * sensitive access, which reopens it. That flag is an explicit operator
   * decision and is not reachable from a model-supplied path, so honouring it
   * here keeps deliberately symlinked trees readable without weakening the
   * default.
   */
  const canonicaliseForPolicy = (relPath: string): Promise<CanonicalPath> =>
    canonicalise(substrate, pathApi, rootPath, relPath);

  const policyPath = async (relPath: string): Promise<{ rel: string } | { decision: DenyDecision }> => {
    const canon = await canonicaliseForPolicy(relPath);
    if ('escape' in canon) return { decision: { blocked: false } };
    if ('outside' in canon) {
      return {
        decision: options.includeSensitive
          ? { blocked: false }
          : { blocked: true, rule: OUTSIDE_WORKSPACE_RULE },
      };
    }
    return { rel: canon.rel };
  };

  const firstMatchingRule = (rules: readonly string[], rel: string): string | undefined => {
    // `ignore` doesn't expose which rule matched, so probe rule-by-rule.
    // This only runs once per blocked op, so the O(n) cost is fine.
    for (const rule of rules) {
      if (ignore().add([rule]).ignores(rel)) return rule;
    }
    return undefined;
  };

  const isBlocked = (ig: Ignore, rel: string): boolean => {
    // Canonicalisation upstream means a `..` segment should never reach this
    // point. If one does, it is blocked rather than reported as policy-clean:
    // treating it as clean is precisely the bypass this guard exists to stop.
    if (!rel) return false;
    if (rel.split('/').includes('..')) return true;
    try {
      return ig.ignores(rel);
    } catch {
      return false;
    }
  };

  return {
    async checkRead(relPath) {
      const target = await policyPath(relPath);
      if ('decision' in target) return target.decision;
      if (!isBlocked(readIg, target.rel)) return { blocked: false };
      return { blocked: true, rule: firstMatchingRule(readRules, target.rel) };
    },
    async checkWrite(relPath) {
      const target = await policyPath(relPath);
      if ('decision' in target) return target.decision;
      if (!isBlocked(writeIg, target.rel)) return { blocked: false };
      return { blocked: true, rule: firstMatchingRule(writeRules, target.rel) };
    },
    async filterReadable(items) {
      const kept: typeof items = [];
      for (const item of items) {
        const target = await policyPath(item.path);
        const blocked = 'decision' in target ? target.decision.blocked : isBlocked(readIg, target.rel);
        if (!blocked) kept.push(item);
      }
      return kept;
    },
  };
}

/** Read `.agent-doignore` at workspace root; empty list if missing or unreadable. */
function readAgentDoIgnore(workingDir: string): string[] {
  const file = path.join(workingDir, AGENT_DO_IGNORE_FILE);
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * Normalise a relative path for matching: strip leading ./, convert
 * backslashes, drop leading slashes. `ignore` expects forward-slash paths.
 */
function normaliseRel(rel: string): string {
  let r = rel.replace(/\\/g, '/');
  while (r.startsWith('./')) r = r.slice(2);
  while (r.startsWith('/')) r = r.slice(1);
  return r;
}

/**
 * Produce a structured blocked ToolResult for a denied read or write.
 * The `rule` flows to `userSummary` + `data` but not `modelContent`.
 *
 * `toolName` is the public tool name (`read_file`, `write_file`, …) so
 * the operator log prefix matches the rest of the rendering
 * (`[read_file] …` rather than `[read] …`).
 */
export function blockedByDenyList(
  toolName: string,
  relPath: string,
  decision: DenyDecision,
): ToolResult {
  const rule = decision.rule ?? '(deny list)';
  return {
    modelContent: `Blocked by deny list: ${relPath}`,
    userSummary: `[${toolName}] ${relPath} — BLOCKED by deny list (${rule})`,
    data: { blocked: true, reason: 'deny-list', rule, tool: toolName, path: relPath },
    blocked: true,
  };
}
