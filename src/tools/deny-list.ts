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
   * Bypass the built-in sensitive-file defaults. The `extra` patterns and
   * any `.agent-doignore` rules still apply. Use only when the user has
   * explicitly opted in via `--include-sensitive`.
   */
  includeSensitive?: boolean;
  /**
   * Skip reading a `.agent-doignore` file at the workspace root. Default
   * behaviour reads one if present. Primarily for tests.
   */
  skipAgentDoIgnore?: boolean;
}

export interface DenyDecision {
  blocked: boolean;
  /** The pattern that matched, if any. Safe to show the operator. */
  rule?: string;
}

export interface DenyGuard {
  checkRead(relPath: string): DenyDecision;
  checkWrite(relPath: string): DenyDecision;
  /**
   * Filter a list of relative paths down to ones that are *at least*
   * readable. Used by grep/find to hide denied entries from results.
   */
  filterReadable<T extends { path: string }>(items: T[]): T[];
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

  const firstMatchingRule = (rules: readonly string[], rel: string): string | undefined => {
    // `ignore` doesn't expose which rule matched, so probe rule-by-rule.
    // This only runs once per blocked op, so the O(n) cost is fine.
    for (const rule of rules) {
      if (ignore().add([rule]).ignores(rel)) return rule;
    }
    return undefined;
  };

  const isBlocked = (ig: Ignore, rel: string): boolean => {
    // `ignore` rejects `..` segments — those paths would escape the
    // workspace anyway, so let the store's traversal guard deal with
    // them by not marking them blocked here.
    if (!rel || rel.includes('..')) return false;
    try {
      return ig.ignores(rel);
    } catch {
      return false;
    }
  };

  return {
    checkRead(relPath) {
      const rel = normaliseRel(relPath);
      if (!isBlocked(readIg, rel)) return { blocked: false };
      return { blocked: true, rule: firstMatchingRule(readRules, rel) };
    },
    checkWrite(relPath) {
      const rel = normaliseRel(relPath);
      if (!isBlocked(writeIg, rel)) return { blocked: false };
      return { blocked: true, rule: firstMatchingRule(writeRules, rel) };
    },
    filterReadable(items) {
      return items.filter((i) => !isBlocked(readIg, normaliseRel(i.path)));
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
 */
export function blockedByDenyList(
  op: 'read' | 'write' | 'edit' | 'delete' | 'list' | 'grep' | 'find',
  relPath: string,
  decision: DenyDecision,
): ToolResult {
  const rule = decision.rule ?? '(deny list)';
  return {
    modelContent: `Blocked by deny list: ${relPath}`,
    userSummary: `[${op}] ${relPath} — BLOCKED by deny list (${rule})`,
    data: { blocked: true, reason: 'deny-list', rule, op, path: relPath },
    blocked: true,
  };
}
