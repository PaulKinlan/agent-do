/**
 * Store interfaces for the agent loop.
 * MemoryStore is the primary storage abstraction for agent file operations.
 */

export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
}

/** Options controlling how a `MemoryStore.search()` interprets `pattern`. */
export interface SearchOptions {
  /**
   * When true, treat `pattern` as a regular expression. When false (the
   * default), treat it as a literal substring match.
   *
   * Literal is the default because it covers the most common LLM use
   * case ("find this exact string") and avoids the catastrophic-
   * backtracking surface (#21) that an LLM-controlled regex creates.
   *
   * Implementations that accept `regex: true` should:
   * - Cap the pattern length (256 chars is the convention).
   * - Reject patterns with obvious nested quantifiers like `(a+)+`.
   */
  regex?: boolean;
}

export interface MemoryStore {
  read(agentId: string, path: string): Promise<string>;
  write(agentId: string, path: string, content: string): Promise<void>;
  append(agentId: string, path: string, content: string): Promise<void>;
  delete(agentId: string, path: string): Promise<void>;
  list(agentId: string, path?: string): Promise<FileEntry[]>;
  mkdir(agentId: string, path: string): Promise<void>;
  exists(agentId: string, path: string): Promise<boolean>;
  search(
    agentId: string,
    pattern: string,
    path?: string,
    options?: SearchOptions,
  ): Promise<Array<{ path: string; line: string }>>;
}
