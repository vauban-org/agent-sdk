import { promises as fs } from "node:fs";
import path from "node:path";
import type { LogMessage } from "../budget/budget-state.js";
import type { JournalAppendMeta, JournalStep, RunJournalPort } from "./types.js";

/**
 * File-backed RunJournalPort over the preste trajectory NDJSON format.
 * `stepIndex` is additive and backward-compatible with TrajectoryStep
 * readers. The journal shares the trajectory file: one file, one in-loop
 * writer, two consumers (recall + fine-tuning export).
 * @public @experimental
 */
export class FileRunJournal implements RunJournalPort {
  private nextIndex = 0;
  private _degraded = false;
  private warned = false;

  constructor(
    private readonly filePath: string,
    private readonly onDegraded?: (reason: string) => void,
  ) {}

  get degraded(): boolean {
    return this._degraded;
  }

  async append(msg: LogMessage, meta?: JournalAppendMeta): Promise<number> {
    if (this._degraded) return -1;
    const step: JournalStep = {
      stepIndex: this.nextIndex,
      timestamp: new Date().toISOString(),
      role: msg.role,
      content: msg.content,
      ...(msg.toolName !== undefined ? { toolName: msg.toolName } : {}),
      ...(meta?.phase !== undefined ? { phase: meta.phase } : {}),
    };
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, `${JSON.stringify(step)}\n`);
      return this.nextIndex++;
    } catch (err) {
      this._degraded = true;
      if (!this.warned) {
        this.warned = true;
        this.onDegraded?.((err as Error).message);
      }
      return -1;
    }
  }

  async read(range: { from: number; to: number }): Promise<JournalStep[]> {
    const steps = await this.load();
    return steps.filter((s) => s.stepIndex >= range.from && s.stepIndex <= range.to);
  }

  async search(query: string, opts?: { topK?: number }): Promise<JournalStep[]> {
    const topK = opts?.topK ?? 5;
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 1);
    if (terms.length === 0) return [];
    const steps = await this.load();
    const scored = steps
      .map((s) => {
        const hay = `${s.toolName ?? ""} ${s.content}`.toLowerCase();
        let score = 0;
        for (const t of terms) if (hay.includes(t)) score++;
        return { s, score };
      })
      .filter((x) => x.score > 0);
    scored.sort((a, b) => b.score - a.score || b.s.stepIndex - a.s.stepIndex);
    return scored.slice(0, topK).map((x) => x.s);
  }

  /** Parse NDJSON; keep journal-authored lines only (stepIndex present); skip malformed. */
  private async load(): Promise<JournalStep[]> {
    let content: string;
    try {
      content = await fs.readFile(this.filePath, "utf-8");
    } catch {
      return [];
    }
    const out: JournalStep[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as Partial<JournalStep>;
        if (
          typeof obj.stepIndex === "number" &&
          typeof obj.content === "string" &&
          typeof obj.role === "string"
        ) {
          out.push(obj as JournalStep);
        }
      } catch {
        /* malformed line tolerated by design (spec §5) */
      }
    }
    return out;
  }
}
