import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileRunJournal } from "../src/run-memory/file-run-journal.js";
import { createRecallTool } from "../src/run-memory/recall-tool.js";
import { ToolRegistryImpl } from "../src/tools/index.js";

function journal(): FileRunJournal {
  return new FileRunJournal(path.join(mkdtempSync(path.join(tmpdir(), "rc-")), "run.jsonl"));
}

describe("createRecallTool", () => {
  it("registers in a ToolRegistry and recalls by steps", async () => {
    const j = journal();
    await j.append({ role: "tool", content: "users table: id, email", toolName: "run_bash" });
    await j.append({ role: "assistant", content: "next: write the migration" });
    const reg = new ToolRegistryImpl();
    expect(reg.register(createRecallTool(j)).ok).toBe(true);
    const res = await reg.execute("recall", { steps: [0] });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(String(res.data)).toContain("[step 0 tool:run_bash]");
      expect(String(res.data)).toContain("users table");
    }
  });

  it("recalls by query (lexical)", async () => {
    const j = journal();
    await j.append({ role: "tool", content: "the API key rotation happens monthly" });
    await j.append({ role: "tool", content: "unrelated content" });
    const tool = createRecallTool(j);
    const out = (await tool.execute({ query: "rotation monthly" })) as string;
    expect(out).toContain("rotation");
    expect(out).not.toContain("unrelated");
  });

  it("rejects params without query nor steps (zod refine)", async () => {
    const reg = new ToolRegistryImpl();
    reg.register(createRecallTool(journal()));
    const res = await reg.execute("recall", {});
    expect(res.ok).toBe(false);
  });

  it("returns a typed message string on empty result (never throws)", async () => {
    const tool = createRecallTool(journal());
    const out = (await tool.execute({ steps: [99] })) as string;
    expect(out).toContain("no matching journaled steps");
  });

  it("caps per-step content", async () => {
    const j = journal();
    await j.append({ role: "tool", content: "z".repeat(10_000) });
    const tool = createRecallTool(j);
    const out = (await tool.execute({ steps: [0] })) as string;
    expect(out.length).toBeLessThan(5_000);
    expect(out).toContain("[truncated]");
  });
});
