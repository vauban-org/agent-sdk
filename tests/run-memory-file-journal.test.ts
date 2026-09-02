import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileRunJournal } from "../src/run-memory/file-run-journal.js";

function tmpFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "rj-")), "run.jsonl");
}

describe("FileRunJournal", () => {
  it("appends with increasing stepIndex and reads back by range", async () => {
    const j = new FileRunJournal(tmpFile());
    expect(await j.append({ role: "assistant", content: "explore db schema" })).toBe(0);
    expect(await j.append({ role: "tool", content: "42 tables found", toolName: "run_bash" })).toBe(
      1,
    );
    expect(await j.append({ role: "assistant", content: "now write migration" })).toBe(2);
    const steps = await j.read({ from: 1, to: 2 });
    expect(steps.map((s) => s.stepIndex)).toEqual([1, 2]);
    expect(steps[0]?.toolName).toBe("run_bash");
  });

  it("search scores by term overlap, most relevant first, bounded topK", async () => {
    const j = new FileRunJournal(tmpFile());
    await j.append({ role: "tool", content: "postgres schema has users table" });
    await j.append({ role: "tool", content: "weather is sunny" });
    await j.append({ role: "tool", content: "users table schema: id, email" });
    const hits = await j.search("users schema", { topK: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.stepIndex).toBe(2);
  });

  it("tolerates malformed lines and ignores non-journal lines (trajectory header)", async () => {
    const file = tmpFile();
    writeFileSync(
      file,
      `${JSON.stringify({ timestamp: "t", role: "system", content: "{}", phase: "header" })}\nnot-json\n`,
    );
    const j = new FileRunJournal(file);
    expect(await j.append({ role: "assistant", content: "hello world" })).toBe(0);
    const all = await j.read({ from: 0, to: 99 });
    expect(all).toHaveLength(1);
  });

  it("degrades fail-soft on write failure: onDegraded fires once, append returns -1", async () => {
    const reasons: string[] = [];
    // Deterministic ENOTDIR: a regular file as a parent path component.
    const blocker = path.join(mkdtempSync(path.join(tmpdir(), "rj-")), "blocker");
    writeFileSync(blocker, "not a directory");
    const j = new FileRunJournal(path.join(blocker, "sub", "run.jsonl"), (r) => reasons.push(r));
    expect(await j.append({ role: "assistant", content: "x" })).toBe(-1);
    expect(await j.append({ role: "assistant", content: "y" })).toBe(-1);
    expect(j.degraded).toBe(true);
    expect(reasons).toHaveLength(1);
  });
});
