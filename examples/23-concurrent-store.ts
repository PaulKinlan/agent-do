/**
 * Example 23: Concurrent MemoryStore access with file locking (#15 Tier 1).
 *
 * When the same agent runs concurrently (orchestrator workers, overlapping
 * run() calls, or cron-driven runs), naive overwriting loses data. Set the
 * opt-in `lock` option and mutating ops serialise per-file across processes.
 *
 * Run: npx tsx examples/23-concurrent-store.ts
 *
 * What this demonstrates:
 *   - Two concurrent append() calls to the SAME file both land (without a
 *     lock, one typically clobbers the other).
 *   - Writes are atomic (temp-file + rename), so readers never see a torn
 *     file even though read() takes no lock.
 *
 * The lock is a zero-dependency sidecar file (O_CREAT|O_EXCL + mtime stale
 * reclaim + retry/backoff), visible across processes sharing the same
 * baseDir. POSIX locks are advisory — every writer must opt in.
 */

import { FilesystemMemoryStore } from 'agent-do';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'agent-do-concurrent-'));
const store = new FilesystemMemoryStore(dataDir, {
  lock: {
    staleMs: 60_000, // reclaim locks left by a crashed process after 1 min
    retry: { count: 50, minDelayMs: 5, maxDelayMs: 50 },
  },
});

// Seed, then race two appends. With the lock they serialise; without it,
// one append frequently overwrites the other.
await store.write('demo', 'tasks.md', '');
await Promise.all([
  store.append('demo', 'tasks.md', '- [ ] task A\n'),
  store.append('demo', 'tasks.md', '- [ ] task B\n'),
  store.append('demo', 'tasks.md', '- [ ] task C\n'),
]);

const content = await store.read('demo', 'tasks.md');
console.log('Final tasks.md (all three lines survived):\n' + content);
console.log(`(data at ${dataDir})`);

// The lock files are invisible to the agent's own view of its dir:
const entries = await store.list('demo');
console.log('list() entries:', entries.map((e) => e.name));
