import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZodError } from "zod";
import {
  recordOutcomeSkill,
  _resetOutcomesIndex,
} from "../src/skills/record-outcome.js";
import { makeCtx } from "./skills-helpers.js";

const VALID_UUID = "22222222-2222-4222-9222-222222222222";

let tmpDir: string;

describe("skill record_outcome", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "out-"));
    _resetOutcomesIndex();
  });
  afterEach(() => {
    _resetOutcomesIndex();
    delete process.env.OUTCOMES_YAML_PATH;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects non-int value_cents via Zod", () => {
    expect(() =>
      recordOutcomeSkill.inputSchema.parse({
        agent_id: "a1",
        agent_run_id: VALID_UUID,
        outcome_type: "trade_pnl",
        value_cents: 1.5,
      }),
    ).toThrow(ZodError);
  });

  it("isReplay=true → no INSERT", async () => {
    const ctx = makeCtx({ isReplay: true });
    const out = await recordOutcomeSkill.execute(
      {
        agent_id: "a1",
        agent_run_id: VALID_UUID,
        outcome_type: "trade_pnl",
        value_cents: 100,
        currency: "USD",
        occurred_at: "2026-04-28T00:00:00.000Z",
      },
      ctx,
    );
    expect(
      (ctx.db as unknown as { query: { mock: { calls: unknown[] } } }).query.mock.calls.length,
    ).toBe(0);
    expect(out.is_pending_backfill).toBe(false);
  });

  it("isReplay=false + yaml lookup sets is_pending_backfill", async () => {
    const path = join(tmpDir, "outcomes.yaml");
    writeFileSync(
      path,
      "outcomes:\n  - type: trade_pnl\n    is_pending_backfill: true\n  - type: cost_savings\n    is_pending_backfill: false\n",
    );
    process.env.OUTCOMES_YAML_PATH = path;
    const ctx = makeCtx({ isReplay: false, rows: [{ id: "out-1" }] });
    const out = await recordOutcomeSkill.execute(
      {
        agent_id: "a1",
        agent_run_id: VALID_UUID,
        outcome_type: "trade_pnl",
        value_cents: 5_00,
        currency: "USD",
        occurred_at: "2026-04-28T00:00:00.000Z",
      },
      ctx,
    );
    expect(out.id).toBe("out-1");
    expect(out.is_pending_backfill).toBe(true);
  });
});
