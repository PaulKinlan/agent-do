/**
 * Saved Routines: named prompt-as-macro procedures (#77).
 *
 * Filesystem-backed routine store implementation and re-exports of core routine tools.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import {
  parseRoutineMd,
  isValidRoutineId,
  ROUTINE_ID_RE,
} from './routines-core.js';
import type { Routine, RoutineStore } from './types.js';

export * from './routines-core.js';

/**
 * Filesystem-backed {@link RoutineStore}. Routines are stored as
 * `<rootDir>/<id>.md` with YAML frontmatter.
 *
 * Run metadata (`runCount`, `lastRun`) lives in
 * `<rootDir>/.runs.json` — a single sidecar file so we're not
 * rewriting SKILL.md-shaped routine files every time a run completes.
 */
export class FilesystemRoutineStore implements RoutineStore {
  private runsCache: Record<string, { runCount: number; lastRun?: string }> | undefined;

  constructor(private readonly rootDir: string) {}

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  private runsFile(): string {
    return join(this.rootDir, '.runs.json');
  }

  private async loadRuns(): Promise<
    Record<string, { runCount: number; lastRun?: string }>
  > {
    if (this.runsCache) return this.runsCache;
    // Null-prototype object so keys like `__proto__` / `constructor` /
    // `prototype` can't shadow Object.prototype members from a hostile
    // sidecar file (Copilot #77 review). Also validates per-entry so a
    // malformed runCount (negative, float, NaN, non-number) doesn't
    // corrupt subsequent increments.
    const cache: Record<string, { runCount: number; lastRun?: string }> =
      Object.create(null);
    try {
      const raw = await fs.readFile(this.runsFile(), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [routineId, rawValue] of Object.entries(parsed)) {
          if (
            routineId === '__proto__' ||
            routineId === 'constructor' ||
            routineId === 'prototype'
          ) {
            continue;
          }
          if (!isValidRoutineId(routineId)) continue;
          if (typeof rawValue !== 'object' || rawValue === null) continue;
          const candidate = rawValue as {
            runCount?: unknown;
            lastRun?: unknown;
          };
          if (
            !Number.isSafeInteger(candidate.runCount) ||
            (candidate.runCount as number) < 0
          ) {
            continue;
          }
          const entry: { runCount: number; lastRun?: string } = {
            runCount: candidate.runCount as number,
          };
          if (typeof candidate.lastRun === 'string') {
            entry.lastRun = candidate.lastRun;
          }
          cache[routineId] = entry;
        }
      }
    } catch {
      // Missing file / malformed JSON → start fresh. Runs tracking is
      // observational; lost counts aren't a correctness problem.
    }
    this.runsCache = cache;
    return cache;
  }

  private async saveRuns(): Promise<void> {
    if (!this.runsCache) return;
    await this.ensureDir();
    await fs.writeFile(this.runsFile(), JSON.stringify(this.runsCache, null, 2), 'utf8');
  }

  async list(): Promise<Routine[]> {
    await this.ensureDir();
    const entries = await fs.readdir(this.rootDir);
    const runs = await this.loadRuns();
    const routines: Routine[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const id = entry.replace(/\.md$/, '');
      if (!isValidRoutineId(id)) continue;
      const content = await fs.readFile(join(this.rootDir, entry), 'utf8');
      const routine = parseRoutineMd(content, id);
      const runData = runs[id];
      if (runData) {
        routine.runCount = runData.runCount;
        routine.lastRun = runData.lastRun;
      }
      routines.push(routine);
    }
    return routines;
  }

  async get(id: string): Promise<Routine | undefined> {
    if (!isValidRoutineId(id)) return undefined;
    try {
      const content = await fs.readFile(join(this.rootDir, `${id}.md`), 'utf8');
      const routine = parseRoutineMd(content, id);
      const runs = await this.loadRuns();
      const runData = runs[id];
      if (runData) {
        routine.runCount = runData.runCount;
        routine.lastRun = runData.lastRun;
      }
      return routine;
    } catch {
      return undefined;
    }
  }

  async save(routine: Routine): Promise<void> {
    if (!isValidRoutineId(routine.id)) {
      throw new TypeError(
        `Routine ID "${routine.id}" must match ${ROUTINE_ID_RE} and not be a reserved name`,
      );
    }
    await this.ensureDir();
    const frontmatter = YAML.stringify({
      name: routine.name,
      description: routine.description,
      ...(routine.version ? { version: routine.version } : {}),
      ...(routine.inputs ? { inputs: routine.inputs } : {}),
    });
    const body = `---\n${frontmatter}---\n\n${routine.body}\n`;
    await fs.writeFile(join(this.rootDir, `${routine.id}.md`), body, 'utf8');

    const runs = await this.loadRuns();
    if (!runs[routine.id]) {
      runs[routine.id] = {
        runCount: routine.runCount ?? 0,
        lastRun: routine.lastRun,
      };
      await this.saveRuns();
    }
  }

  async remove(id: string): Promise<void> {
    if (!isValidRoutineId(id)) return;
    try {
      await fs.unlink(join(this.rootDir, `${id}.md`));
    } catch {
      // Missing file — treat remove() as idempotent.
    }
    const runs = await this.loadRuns();
    if (runs[id]) {
      delete runs[id];
      await this.saveRuns();
    }
  }

  async recordRun(id: string): Promise<void> {
    // Contract: `recordRun` is a no-op for missing routines. Without
    // this check the sidecar could grow entries for routines that never
    // existed (direct attacker-controlled IDs via a hostile `run_routine`
    // call, or IDs the caller passed directly before saving). Also
    // refuse IDs that fail the safe-char regex so prototype-polluting
    // keys like `__proto__` can't enter `.runs.json` this way
    // (Copilot + Codex #77 reviews).
    if (!isValidRoutineId(id)) return;
    try {
      await fs.access(join(this.rootDir, `${id}.md`));
    } catch {
      return; // routine file doesn't exist → no-op
    }
    const runs = await this.loadRuns();
    const existing = runs[id] ?? { runCount: 0 };
    runs[id] = {
      runCount: existing.runCount + 1,
      lastRun: new Date().toISOString(),
    };
    await this.saveRuns();
  }
}
