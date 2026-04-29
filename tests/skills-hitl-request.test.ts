import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { hitlRequest } from "../src/skills/hitl-request.js";
import { makeCtx } from "./skills-helpers.js";

const VALID_UUID = "11111111-1111-4111-9111-111111111111";

describe("skill hitl_request", () => {
  it("rejects non-uuid agent_run_id", () => {
    expect(() =>
      hitlRequest.inputSchema.parse({
        agent_run_id: "not-a-uuid",
        reason: "x",
      }),
    ).toThrow(ZodError);
  });

  it("isReplay=true → no INSERT", async () => {
    const ctx = makeCtx({ isReplay: true });
    const out = await hitlRequest.execute(
      {
        agent_run_id: VALID_UUID,
        reason: "manual review",
        risk_level: "high",
        timeout_seconds: 60,
      },
      ctx,
    );
    expect(
      (ctx.db as unknown as { query: { mock: { calls: unknown[] } } }).query.mock.calls.length,
    ).toBe(0);
    expect(out.status).toBe("replay");
  });

  it("isReplay=false → INSERTs and returns id", async () => {
    const ctx = makeCtx({
      isReplay: false,
      rows: [{ id: "approval-1" }],
    });
    const out = await hitlRequest.execute(
      {
        agent_run_id: VALID_UUID,
        reason: "review",
        risk_level: "medium",
        timeout_seconds: 600,
      },
      ctx,
    );
    expect(out.id).toBe("approval-1");
    expect(out.status).toBe("pending");
  });
});
