/**
 * BrainPort — knowledge archival + retrieval contract.
 *
 * Agents depend on this interface only. Host provides the concrete
 * implementation (e.g. BrainHttpConnector) at service-locator wiring time.
 */

export interface BrainEntryInput {
  content: string;
  content_type?: string;
  author?: string;
  category?: string;
  tags?: string[];
  confidence?: number;
  metadata?: Record<string, unknown>;
  brain_id?: string;
}

export interface BrainEntry {
  id: string;
  content: string;
  category?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export interface BrainQueryFilters {
  category?: string;
  tags?: string[];
  limit?: number;
  [key: string]: unknown;
}

export interface BrainPort {
  /**
   * Archive an atomic knowledge entry. Returns the created entry with id,
   * or null if the write failed (callers treat null as fire-and-forget).
   */
  archiveKnowledge(entry: BrainEntryInput): Promise<BrainEntry | null>;

  /**
   * Optional: query Brain for existing entries (semantic + FTS).
   * Host may omit if the agent does not need read access.
   */
  queryKnowledge?(
    query: string,
    filters?: BrainQueryFilters,
  ): Promise<BrainEntry[]>;
}
