/**
 * run-memory : window-as-cache-over-durable-store primitives for agent loops.
 *
 * The context window becomes a cache over an append-only run journal: every
 * step is journaled BEFORE any in-window eviction, compaction leaves an index
 * of evicted steps, and the `recall` tool re-injects evicted content on
 * demand. Spec: docs/superpowers/specs/2026-07-08-grounded-loop-design.md.
 * @public @experimental
 */
import type { LogMessage } from "../budget/budget-state.js";

/** A journaled step: a LogMessage plus its stable position in the run. @public @experimental */
export interface JournalStep {
  /** 0-based append order within the run journal. */
  stepIndex: number;
  /** ISO 8601 timestamp. */
  timestamp: string;
  role: LogMessage["role"];
  content: string;
  toolName?: string;
  /** Free-form phase tag (trajectory-store compatible). */
  phase?: string;
}

/** @public @experimental */
export interface JournalAppendMeta {
  phase?: string;
}

/**
 * Append-only journal of a single run. Implementations MUST be fail-soft:
 * a storage failure flips `degraded` (onDegraded fires once) but never
 * throws into the loop.
 * @public @experimental
 */
export interface RunJournalPort {
  /** Append one message; resolves to its stepIndex, or -1 when degraded. */
  append(msg: LogMessage, meta?: JournalAppendMeta): Promise<number>;
  /** Read steps by inclusive index range. Missing indices are skipped. */
  read(range: { from: number; to: number }): Promise<JournalStep[]>;
  /** Lexical relevance search over journaled content. */
  search(query: string, opts?: { topK?: number }): Promise<JournalStep[]>;
  /** True once the journal entered degraded (write-failure) mode. */
  readonly degraded: boolean;
}
