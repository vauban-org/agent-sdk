/**
 * TestBrainPort — Map-based BrainPort for unit testing.
 *
 * No Brain HTTP dependency. All four memory tiers are backed by in-memory
 * Maps. Use for agent unit tests that need to archive/query without
 * external infrastructure.
 *
 * OTel spans are emitted on archiveKnowledge and queryKnowledge via
 * @opentelemetry/api. Gracefully degrades to noop spans when no OTel SDK
 * is installed.
 *
 * @public
 */

import type { Span } from "@opentelemetry/api";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type {
  BrainEntry,
  BrainEntryInput,
  BrainPort,
  BrainQueryFilters,
  LessonInput,
  PostmortemInput,
} from "../ports/brain.js";
import {
  InMemoryClaimPort,
  InMemoryEpisodicMemory,
  InMemoryProceduralMemory,
  InMemorySemanticMemory,
  InMemoryWorkingMemory,
} from "../ports/brain.js";
import type {
  ClaimPort,
  EpisodicMemoryPort,
  ProceduralMemoryPort,
  SemanticMemoryPort,
  WorkingMemoryPort,
} from "../ports/brain.js";

const TEST_TRACER = trace.getTracer("vauban-agent-sdk.ports.test", "0.1.0");

export class TestBrainPort implements BrainPort {
  readonly working: WorkingMemoryPort;
  readonly episodic: EpisodicMemoryPort;
  readonly semantic: SemanticMemoryPort;
  readonly procedural: ProceduralMemoryPort;
  readonly claims: ClaimPort;

  private entries = new Map<string, BrainEntry>();
  private nextId = 1;

  constructor() {
    this.working = new InMemoryWorkingMemory();
    this.episodic = new InMemoryEpisodicMemory();
    this.semantic = new InMemorySemanticMemory();
    this.procedural = new InMemoryProceduralMemory();
    this.claims = new InMemoryClaimPort();
  }

  async archiveKnowledge(entry: BrainEntryInput): Promise<BrainEntry | null> {
    return TEST_TRACER.startActiveSpan(
      "brain.archiveKnowledge",
      {
        attributes: {
          "brain.entry.category": entry.category ?? "unknown",
          "brain.entry.content_preview": entry.content.slice(0, 200),
          "brain.entry.tags": entry.tags?.join(",") ?? "",
          "vauban.port.name": "brain",
          "vauban.port.impl": "TestBrainPort",
        },
      },
      async (span: Span) => {
        try {
          const id = `test-${this.nextId++}`;
          const created: BrainEntry = {
            id,
            content: entry.content,
            category: entry.category,
            tags: entry.tags,
            metadata: entry.metadata as Record<string, unknown> | undefined,
            created_at: new Date().toISOString(),
          };
          this.entries.set(id, created);
          span.setAttribute("brain.entry.id", id);
          span.setStatus({ code: SpanStatusCode.OK });
          return created;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          span.setStatus({ code: SpanStatusCode.ERROR, message });
          if (err instanceof Error) span.recordException(err);
          throw err;
        } finally {
          span.end();
        }
      },
    );
  }

  async queryKnowledge(query: string, filters?: BrainQueryFilters): Promise<BrainEntry[]> {
    return TEST_TRACER.startActiveSpan(
      "brain.queryKnowledge",
      {
        attributes: {
          "brain.query.preview": query.slice(0, 200),
          "brain.query.category": filters?.category ?? "none",
          "brain.query.limit": filters?.limit ?? -1,
          "vauban.port.name": "brain",
          "vauban.port.impl": "TestBrainPort",
        },
      },
      async (span: Span) => {
        try {
          let results = Array.from(this.entries.values()).filter((e) =>
            e.content.toLowerCase().includes(query.toLowerCase()),
          );
          if (filters?.category) {
            results = results.filter((e) => e.category === filters.category);
          }
          if (filters?.tags && filters.tags.length > 0) {
            results = results.filter((e) =>
              e.tags?.some((t) => (filters.tags as string[]).includes(t)),
            );
          }
          const limit = (filters?.limit as number) ?? 10;
          const sliced = results.slice(0, limit);
          span.setAttribute("brain.query.result_count", sliced.length);
          span.setStatus({ code: SpanStatusCode.OK });
          return sliced;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          span.setStatus({ code: SpanStatusCode.ERROR, message });
          if (err instanceof Error) span.recordException(err);
          throw err;
        } finally {
          span.end();
        }
      },
    );
  }

  /** No-op: satisfies BrainPort.archivePostmortem for unit tests. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async archivePostmortem(_input: PostmortemInput): Promise<void> {}

  /** No-op: satisfies BrainPort.archiveLesson for unit tests. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async archiveLesson(_input: LessonInput): Promise<void> {}

  /** Clear all entries. */
  reset(): void {
    this.entries.clear();
    this.nextId = 1;
  }
}
