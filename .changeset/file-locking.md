---
"agent-do": minor
---

Add opt-in cross-process file locking to `FilesystemMemoryStore` (#15 Tier 1). Set the `lock` option and mutating ops (`write`/`append`/`delete`/`mkdir`) serialise per-file across every process sharing the same `baseDir` — protecting against orchestrator workers, overlapping `run()` calls, and cron-spawned processes (#79). `undefined` preserves today's naive-overwrite behaviour byte-for-byte.

The lock is a zero-dependency sidecar file (`O_CREAT|O_EXCL` atomic create + mtime-based stale reclaim + retry/backoff with jitter), living in `<baseDir>/.locks/<agentId>/` and invisible to the agent's `list()`/`search()`/`read()`. Writes also become atomic (temp-file + `rename`), so unlocked readers never observe a half-flushed file. A `LockAdapter` option lets you plug in `proper-lockfile`/`fs-ext` for NFS-perfect atomicity without agent-do taking a dependency.

New exports: `acquireFileLock`, `withFileLock`, and types `FileLockOptions`, `LockHandle`, `LockAdapter`. POSIX locks remain advisory (a writer that doesn't opt in can still clobber a locked file). A lazily-imported CRDT-backed store (`agent-do/stores/crdt`, Yjs) is a planned Tier-2 follow-up for genuinely-concurrent *merge* semantics.
