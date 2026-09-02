import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EpisodicMemoryPort } from "../src/ports/brain.js";
import { CompositeRunJournal } from "../src/run-memory/composite-run-journal.js";
import { FileRunJournal } from "../src/run-memory/file-run-journal.js";

function fileJournal(): FileRunJournal {
  return new FileRunJournal(path.join(mkdtempSync(path.join(tmpdir(), "cj-")), "run.jsonl"));
}

function emStub(behavior: "ok" | "throw") {
  const appended: Array<{ agentId: string; sessionId: string; eventType: string }> = [];
  const port = {
    record: async () => {},
    since: async () => [],
    queryByTrace: async () => [],
    query: async () => [],
    append: async (agentId: string, sessionId: string, eventType: string) => {
      if (behavior === "throw") throw new Error("brain down");
      appended.push({ agentId, sessionId, eventType });
      return "em-id";
    },
  } as unknown as EpisodicMemoryPort;
  return { port, appended };
}

describe("CompositeRunJournal", () => {
  it("dual-writes: primary index returned, EM mirror receives the event", async () => {
    const { port, appended } = emStub("ok");
    const j = new CompositeRunJournal(fileJournal(), {
      port,
      agentId: "coder",
      sessionId: "run-1",
    });
    const idx = await j.append({ role: "assistant", content: "step" }, { phase: "loop_step" });
    expect(idx).toBe(0);
    await new Promise((r) => setTimeout(r, 10)); // mirror is fire-and-forget
    expect(appended).toHaveLength(1);
    expect(appended[0]).toEqual({ agentId: "coder", sessionId: "run-1", eventType: "loop_step" });
  });

  it("mirror failure is fail-soft: primary unaffected, one debounced warning", async () => {
    const { port } = emStub("throw");
    const warnings: string[] = [];
    const j = new CompositeRunJournal(
      fileJournal(),
      { port, agentId: "coder", sessionId: "run-1" },
      (r) => warnings.push(r),
    );
    expect(await j.append({ role: "assistant", content: "a" })).toBe(0);
    expect(await j.append({ role: "assistant", content: "b" })).toBe(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(warnings).toHaveLength(1);
    expect(j.degraded).toBe(false);
    expect(await j.read({ from: 0, to: 1 })).toHaveLength(2);
  });
});
