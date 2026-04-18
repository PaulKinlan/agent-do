/**
 * Shared CLI rendering for ProgressEvents.
 *
 * Introduced as part of #48 so prompt / script / eval modes all surface
 * the new structured `summary` + `data` fields consistently. Keeps the
 * per-site switch blocks out of individual mode files.
 *
 * Output goes to stderr so stdout stays clean for the final answer and
 * any piped consumers.
 */

import type { DebugEvent, ProgressEvent } from '../types.js';
import type { ParsedArgs } from './args.js';

export interface RenderOptions {
  verbose: boolean;
  showContent: boolean;
  /** CLI log level (#72). Drives debug-event rendering. */
  logLevel: ParsedArgs['logLevel'];
}

export function renderOptionsFromArgs(args: ParsedArgs): RenderOptions {
  return {
    verbose: args.verbose,
    // --show-content implies verbose (see args.ts).
    showContent: args.showContent,
    logLevel: args.logLevel,
  };
}

/**
 * Render a single ProgressEvent for the CLI.
 *
 * Returns `{ handled: true }` when this helper fully rendered the event
 * and the caller has nothing more to do.
 *
 * Returns `{ handled: false }` when the caller should take additional
 * action — `done` so it can print the final answer to stdout, `error`
 * so it can set a non-zero exit code (the renderer still writes the
 * error text to stderr in that case so the caller doesn't have to).
 */
export function renderEvent(
  event: ProgressEvent,
  opts: RenderOptions,
): { handled: boolean } {
  const { verbose, showContent } = opts;

  switch (event.type) {
    case 'thinking':
      if (verbose) process.stderr.write(event.content);
      return { handled: true };

    case 'tool-call':
      if (verbose) {
        process.stderr.write(
          `\n[tool] ${event.toolName}(${truncateArgs(event.toolArgs)})\n`,
        );
      }
      return { handled: true };

    case 'tool-result':
      if (verbose) renderToolResult(event, showContent);
      return { handled: true };

    case 'text':
      if (verbose && event.content) {
        process.stderr.write(`\n${event.content}\n`);
      }
      return { handled: true };

    case 'done':
      // Caller decides how to print the final answer (stdout).
      return { handled: false };

    case 'step-complete':
      // No CLI surface by default — keeps output readable.
      return { handled: true };

    case 'error':
      // Render to stderr but hand back unhandled so the caller can set a
      // non-zero exit code. Originally these caused `process.exit(1)`
      // directly; #48 stage 4 lost that and CI scripts started seeing
      // exit code 0 on aborts / spending-limit / max-iteration failures.
      process.stderr.write(`Error: ${event.content}\n`);
      return { handled: false };

    case 'debug':
      if (event.debug) renderDebug(event.debug, opts);
      return { handled: true };

    default:
      return { handled: false };
  }
}

/**
 * Render a DebugEvent. Only fires on `--log-level debug` or `trace`.
 * Output is grouped by channel with greppable prefixes.
 */
function renderDebug(event: DebugEvent, opts: RenderOptions): void {
  const rank = logLevelRank(opts.logLevel);
  const wantDebug = rank >= logLevelRank('debug');
  const wantTrace = rank >= logLevelRank('trace');
  if (!wantDebug) return;

  switch (event.channel) {
    case 'system-prompt': {
      const tag = event.truncated ? ' (truncated)' : '';
      process.stderr.write(
        `\n[debug:system-prompt] ${event.bytes} bytes${tag}\n─── system prompt ───\n${event.content}\n─────────────────────\n`,
      );
      return;
    }
    case 'messages': {
      const tag = event.truncated ? ' (some bodies truncated)' : '';
      process.stderr.write(
        `\n[debug:messages] step=${event.step} count=${event.messages.length} bytes=${event.bytes}${tag}\n`,
      );
      if (wantTrace) {
        for (const [idx, msg] of event.messages.entries()) {
          const body = typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content);
          process.stderr.write(
            `  [${idx}] ${msg.role}: ${truncate(body, 200)}\n`,
          );
        }
      }
      return;
    }
    case 'request': {
      const tools = event.toolNames.length > 0
        ? ` tools=[${event.toolNames.slice(0, 6).join(',')}${event.toolNames.length > 6 ? ',…' : ''}]`
        : ' tools=none';
      process.stderr.write(
        `[debug:request] step=${event.step} model=${event.model}${tools}\n`,
      );
      return;
    }
    case 'response-part': {
      // Emit per-part output only at trace. At `debug` level we omit
      // it — the full-stream firehose is too noisy for the compact
      // view.
      if (wantTrace) {
        const detail = event.part ? ` ${truncate(JSON.stringify(event.part), 160)}` : '';
        process.stderr.write(
          `[debug:response-part] step=${event.step} ${event.partType}${detail}\n`,
        );
      }
      return;
    }
    case 'cache': {
      const total = event.cacheReadTokens + event.cacheWriteTokens + event.noCacheTokens;
      const hitPct = total > 0 ? Math.round((event.cacheReadTokens / total) * 100) : 0;
      process.stderr.write(
        `[debug:cache] step=${event.step} read=${event.cacheReadTokens} write=${event.cacheWriteTokens} no-cache=${event.noCacheTokens} out=${event.outputTokens} hit=${hitPct}%\n`,
      );
      return;
    }
  }
}

function logLevelRank(level: ParsedArgs['logLevel']): number {
  switch (level) {
    case 'silent': return 0;
    case 'info': return 1;
    case 'verbose': return 2;
    case 'debug': return 3;
    case 'trace': return 4;
  }
}

function renderToolResult(event: ProgressEvent, showContent: boolean): void {
  const prefix = event.blocked ? '[blocked]' : '[result]';
  const summary = event.summary ?? '(no summary)';
  process.stderr.write(`       → ${prefix} ${summary}\n`);

  // If the tool attached structured data, surface a compact preview on
  // one line. Long values are truncated; secrets in `data` should never
  // make it here (it's for metadata like `bytes`, `lines`, `rule`).
  if (event.data && Object.keys(event.data).length > 0) {
    const compact = formatData(event.data);
    if (compact) process.stderr.write(`         data: ${compact}\n`);
  }

  if (showContent) {
    const body = formatFullResult(event.toolResult);
    if (body) {
      process.stderr.write(
        `         ─── content ───\n${indent(body, '         ')}\n         ────────────────\n`,
      );
    }
  }
}

function formatData(data: Record<string, unknown>): string {
  // Drop noisy / redundant fields; keep the important ones near the
  // front for readability.
  const parts: string[] = [];
  const order = [
    'path', 'bytes', 'lines', 'truncated', 'redactedMarkerCount',
    'matchCount', 'fileCount', 'count', 'hiddenByDenyList',
    'blocked', 'reason', 'rule',
  ];
  for (const key of order) {
    if (key in data && data[key] !== undefined) {
      parts.push(`${key}=${formatValue(data[key])}`);
    }
  }
  // Catch any other scalar keys (skip nested objects to keep the line short).
  for (const [k, v] of Object.entries(data)) {
    if (order.includes(k)) continue;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') continue;
    parts.push(`${k}=${formatValue(v)}`);
  }
  return parts.join(', ');
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return v.length > 40 ? `${v.slice(0, 40)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function formatFullResult(r: unknown): string | undefined {
  if (r === undefined || r === null) return undefined;
  if (typeof r === 'string') return r;
  if (typeof r === 'object' && r !== null && 'modelContent' in r) {
    // If it's a ToolResult, show the model-facing view by default.
    return String((r as { modelContent: unknown }).modelContent);
  }
  try {
    return JSON.stringify(r, null, 2);
  } catch {
    return String(r);
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function truncateArgs(args: unknown): string {
  const s = JSON.stringify(args ?? {});
  return truncate(s, 120);
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}
