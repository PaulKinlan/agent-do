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

import type { ProgressEvent } from '../types.js';
import type { ParsedArgs } from './args.js';

export interface RenderOptions {
  verbose: boolean;
  showContent: boolean;
}

export function renderOptionsFromArgs(args: ParsedArgs): RenderOptions {
  return {
    verbose: args.verbose,
    // --show-content implies verbose (see args.ts).
    showContent: args.showContent,
  };
}

/**
 * Render a single ProgressEvent for the CLI. Returns `true` if the event
 * should be passed through to the caller's own rendering (e.g. `done`
 * events that the caller wants to print to stdout as the final answer).
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
      process.stderr.write(`Error: ${event.content}\n`);
      return { handled: true };

    default:
      return { handled: false };
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
