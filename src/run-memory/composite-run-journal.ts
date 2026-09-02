import type { LogMessage } from "../budget/budget-state.js";
import type { EpisodicMemoryPort } from "../ports/brain.js";
import type { JournalAppendMeta, JournalStep, RunJournalPort } from "./types.js";

/**
 * Dual-write journal: the primary (file) stays the local source of truth;
 * appends are mirrored into Brain Episodic Memory fire-and-forget with a
 * single debounced warning on failure (spec §5 : Brain down costs the
 * mirror, never the run). Reads and search delegate to the primary; semantic
 * recall over EM lands with the SDK-port phase.
 * @public @experimental
 */
export class CompositeRunJournal implements RunJournalPort {
  private warned = false;

  constructor(
    private readonly primary: RunJournalPort,
    private readonly mirror: {
      port: EpisodicMemoryPort;
      agentId: string;
      sessionId: string;
    },
    private readonly onMirrorError?: (reason: string) => void,
  ) {}

  get degraded(): boolean {
    return this.primary.degraded;
  }

  async append(msg: LogMessage, meta?: JournalAppendMeta): Promise<number> {
    const idx = await this.primary.append(msg, meta);
    void this.mirror.port
      .append(
        this.mirror.agentId,
        this.mirror.sessionId,
        meta?.phase ?? "loop_step",
        {
          stepIndex: idx,
          role: msg.role,
          content: msg.content,
          ...(msg.toolName !== undefined ? { toolName: msg.toolName } : {}),
        },
        { importanceScore: 0.4 },
      )
      .catch((err: unknown) => {
        if (!this.warned) {
          this.warned = true;
          this.onMirrorError?.((err as Error).message);
        }
      });
    return idx;
  }

  read(range: { from: number; to: number }): Promise<JournalStep[]> {
    return this.primary.read(range);
  }

  search(query: string, opts?: { topK?: number }): Promise<JournalStep[]> {
    return this.primary.search(query, opts);
  }
}
