/**
 * Shellm — prompt files as executable scripts (#16).
 *
 * A shellm file is a plain-text prompt, optionally preceded by a shebang
 * (`#!/usr/bin/env agent-do`) and YAML frontmatter. Run it directly:
 *
 *     $ chmod +x summary.shellm
 *     $ ./summary.shellm            # kernel turns the shebang into
 *                                   # `agent-do /abs/path/summary.shellm`
 *
 * …or explicitly:
 *
 *     $ agent-do ./summary.shellm
 *     $ cat data.csv | ./analyze.shellm
 *
 * Prompt mode detects a shellm file when the first positional arg is a
 * readable file AND it opts in via EITHER a `.shellm` extension OR an
 * `agent-do` shebang on its first line. That dual opt-in keeps
 * `agent-do readme.md` meaning "the prompt is the literal string
 * readme.md" (today's behaviour) instead of silently reading the file.
 *
 * Frontmatter (optional) carries run config:
 *
 *     ---
 *     provider: google
 *     model: gemini-2.5-flash
 *     system: You are a code reviewer. Be terse.
 *     ---
 *     Review the staged diff for bugs.
 *
 * ## Security
 *
 * A shellm file is DATA (a prompt), not CODE — parsing it never
 * `import()`s anything (unlike `agent-do run x.ts --script`). The trust
 * model matches `cat file | agent-do "prompt"`: the file's contents
 * reach the model, and with the default workspace tools the agent can
 * read/write/edit files in `--cwd`. Don't run shellm files from sources
 * you don't trust — same rule as shell scripts. `--read-only` /
 * `--no-tools` narrow the blast radius exactly as for a normal prompt.
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import YAML from 'yaml';

/** Max bytes we'll read from a shellm file. Mirrors script-mode cap. */
const SHELLM_MAX_BYTES = 2 * 1024 * 1024;

export interface ShellmConfig {
  /** Overrides `--provider` when present. */
  provider?: string;
  /** Overrides `--model` when present. */
  model?: string;
  /** Overrides `--system` when present. */
  system?: string;
  /**
   * Saved agent name. Reserved in v1 — not wired (loading a saved agent
   * is a follow-up; it needs the runSavedAgent machinery from script.ts).
   * Parsed and validated so a typo surfaces clearly instead of being
   * silently ignored.
   */
  agent?: string;
}

export interface ParsedShellm {
  /** The prompt body (frontmatter and shebang stripped, trimmed). */
  prompt: string;
  config: ShellmConfig;
}

/**
 * Read and validate a shellm file's raw contents. Throws on non-file
 * targets or files exceeding the size cap.
 */
export async function readShellmFile(filePath: string): Promise<string> {
  const s = await stat(filePath);
  if (!s.isFile()) {
    throw new Error(`Shellm target is not a regular file: ${filePath}`);
  }
  if (s.size > SHELLM_MAX_BYTES) {
    throw new Error(
      `Shellm file is ${s.size} bytes (limit ${SHELLM_MAX_BYTES}). ` +
        `A prompt file this large is almost certainly a mistake.`,
    );
  }
  return readFile(filePath, 'utf-8');
}

/**
 * Parse raw shellm file contents into a prompt body + optional config.
 * Strips a leading shebang line and an optional YAML frontmatter block.
 */
export function parseShellm(content: string): ParsedShellm {
  let src = content;

  // Strip a leading shebang. The kernel consumed it to dispatch when run
  // via `./file.shellm`; when invoked as `agent-do file.shellm` the raw
  // bytes still include it, and we don't want it reaching the model.
  if (src.startsWith('#!')) {
    const nl = src.indexOf('\n');
    src = nl === -1 ? '' : src.slice(nl + 1);
  }

  const split = splitFrontmatter(src);
  if (!split) {
    return { prompt: src.trim(), config: {} };
  }
  return {
    prompt: split.body.trim(),
    config: parseFrontmatterConfig(split.frontmatter),
  };
}

/**
 * Detect whether a positional prompt argument is a shellm file and, if
 * so, parse it. Returns `null` when the arg is NOT a shellm file — the
 * caller then treats it as a literal prompt string (today's behaviour).
 *
 * Opt-in is explicit and unambiguous: the target must be a regular file
 * AND either carry a `.shellm` extension OR begin with an `agent-do`
 * shebang. Without this gate, `agent-do readme.md` would silently read
 * the file instead of passing the literal string to the model.
 */
export async function tryParseShellm(
  positional: string,
): Promise<ParsedShellm | null> {
  // A multi-line or multi-token positional is never a file path we want
  // to auto-load — it's a literal prompt like "summarize ./readme.md".
  if (positional.includes('\n')) return null;
  if (positional.trim().split(/\s+/).length > 1) return null;

  const filePath = resolve(positional);
  let content: string;
  try {
    content = await readShellmFile(filePath);
  } catch {
    // Not a file, unreadable, or too large — fall through to literal.
    return null;
  }

  const isShellmExt = /\.shellm$/i.test(positional);
  const hasAgentDoShebang = /^#![^\n]*\bagent-do\b/.test(content);
  if (!isShellmExt && !hasAgentDoShebang) return null;

  return parseShellm(content);
}

// ── Frontmatter (ReDoS-safe) ───────────────────────────────────────────
//
// Same line-based, O(n) splitter used by policies.ts. A shared
// `src/utils/frontmatter.ts` helper is the obvious future cleanup so
// skills.ts / routines.ts / policies.ts / shellm.ts stop carrying
// near-identical copies; tracked separately to keep this change focused.

function parseFrontmatterConfig(frontmatter: string): ShellmConfig {
  if (!frontmatter.trim()) return {};
  let parsed: Record<string, unknown> = {};
  try {
    const out = YAML.parse(frontmatter);
    if (out && typeof out === 'object' && !Array.isArray(out)) {
      parsed = out as Record<string, unknown>;
    }
  } catch {
    // Malformed YAML — ignore the config block but keep the prompt body.
    return {};
  }
  const cfg: ShellmConfig = {};
  if (typeof parsed.provider === 'string' && parsed.provider.trim()) {
    cfg.provider = parsed.provider.trim();
  }
  if (typeof parsed.model === 'string' && parsed.model.trim()) {
    cfg.model = parsed.model.trim();
  }
  if (typeof parsed.system === 'string' && parsed.system.trim()) {
    cfg.system = parsed.system.trim();
  }
  if (typeof parsed.agent === 'string' && parsed.agent.trim()) {
    cfg.agent = parsed.agent.trim();
  }
  return cfg;
}

/**
 * Split a document into YAML frontmatter + body without the
 * catastrophic-backtracking risk of `/^---\n([\s\S]*?)\n---\n/`
 * (CodeQL `js/polynomial-redos`). See policies.ts for the full
 * rationale; this is a copy pending shared-helper extraction.
 */
function splitFrontmatter(content: string): { frontmatter: string; body: string } | null {
  const openEnd = fenceLineEnd(content, 0);
  if (openEnd === -1) return null;
  if (openEnd >= content.length || content[openEnd] !== '\n') return null;
  const afterOpen = openEnd + 1;

  let lineStart = afterOpen;
  let searchFrom = afterOpen;
  while (searchFrom <= content.length) {
    const nextNl = content.indexOf('\n', searchFrom);
    const lineEnd = nextNl === -1 ? content.length : nextNl;
    if (fenceLineEnd(content, lineStart) === lineEnd) {
      if (lineEnd >= content.length) break; // bare trailing `---` → no match
      const frontEnd = Math.max(afterOpen, lineStart - 1);
      return {
        frontmatter: content.slice(afterOpen, frontEnd),
        body: content.slice(lineEnd + 1),
      };
    }
    if (nextNl === -1) break;
    lineStart = nextNl + 1;
    searchFrom = nextNl + 1;
  }
  return null;
}

function fenceLineEnd(s: string, start: number): number {
  if (s[start] !== '-' || s[start + 1] !== '-' || s[start + 2] !== '-') return -1;
  let i = start + 3;
  while (s[i] === ' ' || s[i] === '\t' || s[i] === '\r') i++;
  return i;
}
