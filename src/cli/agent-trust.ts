/**
 * Provenance for saved agent configs (agent-do-5re).
 *
 * `loadSavedAgent` finds `.agent-do/agents/<name>.json` by walking **up** from the working directory, so the
 * file it ends up reading may belong to a repository rather than to the operator: a clone, a checked-out
 * branch, an extracted tarball, a shared workspace. Its `systemPrompt` then goes straight into
 * `createAgent`, which is the highest-trust position in the prompt, with the agent's tools attached
 * (`runSavedAgent`, src/cli/script.ts). The Zod schema validates the SHAPE of that file and can never
 * validate its PROVENANCE — a schema-valid file is exactly what an attacker would plant.
 *
 * So provenance is **recorded**, not inferred. There is no path heuristic that answers "did the operator
 * write this?":
 *
 *   - "inside the home directory" is close to useless, because most repositories live under `$HOME`;
 *   - "owned by this user, not world-writable" does not survive a `git clone`, because checkout creates the
 *     files as the operator;
 *   - "not tracked by git" misses a tarball and taints an operator's own committed config.
 *
 * What IS knowable is whether this exact content has been sanctioned on this machine:
 *
 *   - `agent-do create` records `{ resolved path, sha256 }` of the bytes it wrote;
 *   - `agent-do run <name>` promotes the prompt only while the file on disk still hashes to a recorded value;
 *   - anything else — never recorded, or recorded and then changed — needs an explicit
 *     `--trust-agent-config`, which records the current content.
 *
 * The record is a hash, not a signature. It establishes "this machine's operator sanctioned this content",
 * which is the property that decides whether the text belongs in the system tier. It is not a claim that the
 * content is safe — an operator can `--trust-agent-config` a hostile file just as they can `--script` one;
 * both are explicit, reviewable decisions rather than a directory lookup nobody saw.
 *
 * The store lives outside every workspace (`~/.agent-do/trusted-agents.json`) so a repository cannot write to
 * it. Its path is overridable with `AGENT_DO_TRUST_STORE` — tests must never touch the real home directory.
 *
 * Two surfaces supply instructions this way, and both are gated by the same store (agent-do-5re, agent-do-e29):
 *
 *   - a saved agent config (`.agent-do/agents/<name>.json`), whose `systemPrompt` becomes the system prompt after a
 *     name lookup that walks up from the working directory; and
 *   - a shellm prompt file's `system:` frontmatter, which replaces the system prompt of that run. Its prompt BODY is
 *     not gated — that is the task, the same text piping a file into `agent-do` would supply.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sanitiseForLine } from './terminal-safety.js';

/** Environment override for the trust store path (tests, and operators with an unusual home layout). */
export const TRUST_STORE_ENV = 'AGENT_DO_TRUST_STORE';

const STORE_VERSION = 1;

/**
 * Upper bound on recorded configs. The store is only written when the operator vets a file, so this is not a
 * growth risk in practice; the bound exists so a hand-edited or corrupted store cannot make every `run` read
 * an unbounded file. Oldest entries are dropped first.
 */
const MAX_RECORDED_ENTRIES = 512;

export interface TrustEntry {
  /** sha256 (hex) of the file content that was sanctioned. */
  sha256: string;
  /** ISO timestamp of when it was recorded — only for diagnostics and the eviction order. */
  recordedAt: string;
}

export interface TrustStore {
  version: number;
  /** Keyed by the resolved absolute path of the config file. */
  agents: Record<string, TrustEntry>;
}

/** Why a check passed or failed. `content-changed` is the loud one: something rewrote a vetted file. */
export type TrustReason = 'trusted' | 'not-recorded' | 'content-changed' | 'store-unreadable';

export interface TrustCheck {
  trusted: boolean;
  reason: TrustReason;
  /** For `store-unreadable`: the underlying error message, for the operator-facing diagnostic. */
  detail?: string;
  /** For `content-changed`: the sha256 that WAS vetted, so the operator can see what moved. */
  recordedSha256?: string;
}

/** The resolved path the trust store keys on. */
export function trustKeyFor(filePath: string): string {
  return path.resolve(filePath);
}

export function trustStorePath(): string {
  const override = process.env[TRUST_STORE_ENV];
  if (typeof override === 'string' && override.trim() !== '') {
    return path.resolve(override.trim());
  }
  return path.join(os.homedir(), '.agent-do', 'trusted-agents.json');
}

/** sha256 of the exact bytes that were parsed. Content is the unit of trust, not the file's metadata. */
export function hashContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function emptyStore(): TrustStore {
  return { version: STORE_VERSION, agents: {} };
}

function isTrustEntry(value: unknown): value is TrustEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(v.sha256) &&
    typeof v.recordedAt === 'string'
  );
}

/**
 * Read the store. A missing store is an empty store (nothing vetted yet — not an error). A store that cannot
 * be read or does not look like a store is reported, because silently treating it as empty would turn "your
 * vetted configs are unreadable" into "everything is untrusted, pass a flag", which hides the cause.
 */
export async function readTrustStore(): Promise<{ store: TrustStore; error?: string }> {
  const file = trustStorePath();
  let text: string;
  try {
    text = await fs.promises.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { store: emptyStore() };
    }
    return { store: emptyStore(), error: err instanceof Error ? err.message : String(err) };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { store: emptyStore(), error: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { store: emptyStore(), error: 'not a JSON object' };
  }
  const agents = (raw as { agents?: unknown }).agents;
  if (typeof agents !== 'object' || agents === null || Array.isArray(agents)) {
    return { store: emptyStore(), error: 'missing an `agents` object' };
  }

  const store = emptyStore();
  for (const [key, entry] of Object.entries(agents as Record<string, unknown>)) {
    // Drop malformed entries rather than failing the whole store: one hand-edited line should not make every
    // other vetted config untrusted. A dropped entry is simply "not recorded", which fails closed.
    if (isTrustEntry(entry)) store.agents[key] = entry;
  }
  return { store };
}

/**
 * Decide trust from an already-read store. Pure, so the listing can read the store once and check many files.
 */
export function evaluateTrust(store: TrustStore, filePath: string, sha256: string): TrustCheck {
  const entry = store.agents[trustKeyFor(filePath)];
  if (!entry) return { trusted: false, reason: 'not-recorded' };
  if (entry.sha256 !== sha256) {
    return { trusted: false, reason: 'content-changed', recordedSha256: entry.sha256 };
  }
  return { trusted: true, reason: 'trusted' };
}

/** Read the store and decide trust for one config file. */
export async function checkAgentTrust(filePath: string, sha256: string): Promise<TrustCheck> {
  const { store, error } = await readTrustStore();
  if (error) return { trusted: false, reason: 'store-unreadable', detail: error };
  return evaluateTrust(store, filePath, sha256);
}

/**
 * Record (or refresh) trust for a config file. Written atomically via a temp file + rename, so an interrupted
 * write cannot leave a half-store that makes every other entry unreadable.
 *
 * Returns a failure instead of throwing: failing to remember a decision must not break the run the operator
 * just authorised. An unreadable store is replaced rather than merged — the caller reports that, and the
 * entries it could not read were already unusable.
 */
export async function recordAgentTrust(
  filePath: string,
  sha256: string,
): Promise<{ recorded: true; replacedUnreadableStore: boolean } | { recorded: false; detail: string }> {
  const file = trustStorePath();
  const { store, error } = await readTrustStore();

  const key = trustKeyFor(filePath);
  const agents: Record<string, TrustEntry> = { ...store.agents };
  agents[key] = { sha256, recordedAt: new Date().toISOString() };

  // Keep the newest MAX_RECORDED_ENTRIES.
  const keys = Object.keys(agents);
  if (keys.length > MAX_RECORDED_ENTRIES) {
    keys
      .sort((a, b) => (agents[a]!.recordedAt < agents[b]!.recordedAt ? -1 : 1))
      .slice(0, keys.length - MAX_RECORDED_ENTRIES)
      .forEach((stale) => delete agents[stale]);
  }

  const payload = JSON.stringify({ version: STORE_VERSION, agents } satisfies TrustStore, null, 2) + '\n';
  const dir = path.dirname(file);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(tmp, payload, { mode: 0o600 });
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    return { recorded: false, detail: err instanceof Error ? err.message : String(err) };
  }
  return { recorded: true, replacedUnreadableStore: error !== undefined };
}

/**
 * Render one operator-facing line. The SEQUENCE of lines is ours; every interpolated value — a file path read
 * from disk, an fs error that quotes a path, a recorded hash — goes through `sanitiseForLine` so a planted
 * filename cannot forge a second `[agent-do] …` line or drive the terminal (agent-do-2ey, agent-do-axt).
 */
function line(parts: readonly string[]): string {
  return `[agent-do] ${parts.map((p) => sanitiseForLine(p)).join('')}\n`;
}

/**
 * Where the instructions came from. The store and the mechanics are shared; only the wording differs, because
 * the remedy differs: a saved agent config is re-created, a shellm file is one key away from being a plain
 * prompt file (agent-do-5re, agent-do-e29).
 */
export type InstructionSource = 'saved-agent' | 'shellm';

const SOURCE_TEXT: Record<InstructionSource, { what: string; remedy: string }> = {
  'saved-agent': {
    what: 'Saved agent config',
    remedy:
      'This file was not created by `agent-do create` on this machine, or its content changed after it was ' +
      'recorded, so its systemPrompt is not promoted to the trusted system tier. Re-create it with ' +
      '`agent-do create`, or re-run with --trust-agent-config to accept this exact content.',
  },
  shellm: {
    what: 'Shellm prompt file',
    remedy:
      'This file\'s `system:` frontmatter was not trusted on this machine, or the file changed after it was ' +
      'trusted, so it is not promoted to the trusted system tier (the prompt body is unaffected). Re-run with ' +
      '--trust-agent-config to accept this content, or drop the `system:` key so the file only supplies the ' +
      'prompt.',
  },
};

/** Short, operator-readable phrasing of a check result, used in the thrown error. */
const REASON_PHRASE: Record<TrustReason, string> = {
  trusted: 'trusted',
  'not-recorded': 'never vetted on this machine',
  'content-changed': 'content changed since it was vetted',
  'store-unreadable': 'the trust store could not be read',
};

/**
 * Enforce provenance for one file whose contents would become (part of) the system prompt.
 *
 * Throws — before any model call, tool construction or memory write — when the instructions would otherwise be
 * promoted to the system tier without the operator having sanctioned them. `accept` is the operator's explicit
 * `--trust-agent-config`: it records the current content and proceeds.
 */
export async function requireInstructionTrust(
  filePath: string,
  sha256: string,
  opts: { accept: boolean; kind: InstructionSource; write?: (chunk: string) => void },
): Promise<void> {
  const write = opts.write ?? ((chunk: string) => process.stderr.write(chunk));
  const { what, remedy } = SOURCE_TEXT[opts.kind];
  const check = await checkAgentTrust(filePath, sha256);

  if (check.trusted) return;

  const why =
    check.reason === 'content-changed'
      ? line([
          what,
          ' ',
          filePath,
          ' changed since it was trusted (was ',
          (check.recordedSha256 ?? '').slice(0, 16),
          '…, now ',
          sha256.slice(0, 16),
          '…).',
        ])
      : check.reason === 'store-unreadable'
        ? line(['Trust store ', trustStorePath(), ' could not be read: ', check.detail ?? 'unknown error', '.'])
        : line([what, ' ', filePath, ' has not been trusted on this machine.']);

  if (!opts.accept) {
    write(why);
    write(line([remedy]));
    // The reason travels in the error too: a caller that only sees the thrown message (or a test) must not have to
    // scrape stderr to learn whether the file was never vetted or was vetted and then rewritten.
    throw new Error(
      `Refusing to use instructions from a file that has not been trusted on this machine ` +
        `(${REASON_PHRASE[check.reason]}): ${path.resolve(filePath)}`,
    );
  }

  write(why);
  const recorded = await recordAgentTrust(filePath, sha256);
  if (recorded.recorded) {
    if (recorded.replacedUnreadableStore) {
      write(line(['Trust store ', trustStorePath(), ' was unreadable and has been replaced.']));
    }
    write(line(['--trust-agent-config: recording trust for ', filePath, '.']));
  } else {
    // Not fatal: the operator authorised THIS run. It just will not be remembered.
    write(line(['Could not record trust in ', trustStorePath(), ': ', recorded.detail, '.']));
  }
}


/** Gate a saved agent config (agent-do-5re). */
export function requireSavedAgentTrust(
  filePath: string,
  sha256: string,
  opts: { accept: boolean; write?: (chunk: string) => void },
): Promise<void> {
  return requireInstructionTrust(filePath, sha256, { ...opts, kind: 'saved-agent' });
}

/**
 * Gate a shellm file's `system:` frontmatter (agent-do-e29).
 *
 * The prompt BODY is not gated: it is the task, the same text piping a file into `agent-do` would supply, and
 * making it trusted would make shellm pointless. What is gated is the frontmatter key that quietly replaces the
 * system prompt of the run.
 */
export function requireShellmTrust(
  filePath: string,
  sha256: string,
  opts: { accept: boolean; write?: (chunk: string) => void },
): Promise<void> {
  return requireInstructionTrust(filePath, sha256, { ...opts, kind: 'shellm' });
}
