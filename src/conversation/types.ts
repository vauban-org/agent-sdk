/**
 * ConversationContext types — tiered memory for multi-turn agents.
 * @public @since 2.3.0
 */

/**
 * A single conversation turn (non-system).
 * @public
 */
export interface Turn {
  readonly role: "user" | "assistant";
  readonly content: string;
  /** Optional metadata captured at addTurn() time. */
  readonly meta?: {
    readonly timestamp?: number;
    readonly tokensIn?: number;
    readonly tokensOut?: number;
    readonly model?: string;
    readonly provider?: string;
    /**
     * What a human observer should see this turn's content as, when it
     * differs from `content` (e.g. a host composed `content` from the raw
     * request plus an injected envelope for the model). Display-only : never
     * read by toMessages(), estimatedTokens(), or compact() ; a host that
     * replays turn history for a human audience (e.g. seeding a remote
     * transcript) reads `meta.displayContent ?? content`. Absent = no
     * composition happened, `content` is already the raw request.
     * @since sprint-1066 (t2-clean-task-field)
     */
    readonly displayContent?: string;
  };
}

/**
 * A compacted summary of N prior turns.
 * @public
 */
export interface CompactionSummary {
  /** When the compaction happened (epoch ms). */
  readonly createdAt: number;
  /** Number of turns summarized. */
  readonly turnCount: number;
  /** Estimated token count of the original turns. */
  readonly originalTokens: number;
  /** The summary text (LLM-generated). */
  readonly text: string;
}

/**
 * Return value of compact().
 * @public
 */
export interface CompactionReport {
  readonly turnsBefore: number;
  readonly turnsAfter: number;
  readonly summariesAdded: number;
  readonly tokensEstimatedBefore: number;
  readonly tokensEstimatedAfter: number;
}

/**
 * Serialization snapshot written by toJSON() / read by fromJSON().
 * @public
 */
export interface ConversationContextSnapshot {
  readonly version: 1;
  readonly workingMemorySize: number;
  readonly turns: readonly Turn[];
  readonly summaries: readonly CompactionSummary[];
}

/**
 * Chat-style message returned by toMessages() for react/plan strategies.
 * Identical shape to StrategyMessage but without tool-call fields.
 * @public
 */
export interface LLMMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/**
 * Options for ConversationContext constructor.
 * @public
 */
export interface ConversationContextOpts {
  /** How many recent turns to keep verbatim during compaction. Default: 6. */
  readonly workingMemorySize?: number;
  /**
   * Resolves a model id to its context window size (tokens), consulted by
   * `maybeCompact()` in place of the static fallback map. Absent = the
   * static map's behavior, byte-identical to pre-injection callers. Hosts
   * that already deduce a model's real window (e.g. from a provider's
   * `/model/info` endpoint) SHOULD inject it here instead of relying on
   * the SDK's necessarily-stale static table.
   */
  readonly getContextWindow?: (model: string) => number;
}
