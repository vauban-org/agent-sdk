import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { runSqlQuery, isReadOnlySql } from "../src/skills/run-sql-query.js";
import { SqlReadOnlyViolation } from "../src/skills/errors.js";
import { makeCtx } from "./skills-helpers.js";

describe("skill run_sql_query", () => {
  it("rejects empty SQL", () => {
    expect(() => runSqlQuery.inputSchema.parse({ sql: "" })).toThrow(ZodError);
  });

  it("isReadOnlySql detects writes", () => {
    expect(isReadOnlySql("SELECT * FROM t")).toBe(true);
    expect(isReadOnlySql("INSERT INTO t VALUES (1)")).toBe(false);
    expect(isReadOnlySql("UPDATE t SET a=1")).toBe(false);
    expect(isReadOnlySql("DROP TABLE t")).toBe(false);
    // Write keyword inside a string literal must NOT trigger
    expect(isReadOnlySql("SELECT 'INSERT' as label")).toBe(true);
  });

  it("rejects write SQL with SqlReadOnlyViolation", async () => {
    const ctx = makeCtx({ isReplay: false });
    await expect(
      runSqlQuery.execute({ sql: "DELETE FROM x" }, ctx),
    ).rejects.toBeInstanceOf(SqlReadOnlyViolation);
  });

  it("isReplay=true → no DB call", async () => {
    const ctx = makeCtx({ isReplay: true, rows: [{ a: 1 }] });
    const out = await runSqlQuery.execute({ sql: "SELECT 1" }, ctx);
    expect(
      (ctx.db as unknown as { query: { mock: { calls: unknown[] } } }).query.mock.calls.length,
    ).toBe(0);
    expect(out.rowCount).toBe(0);
  });

  it("isReplay=false → calls db.query", async () => {
    const ctx = makeCtx({ isReplay: false, rows: [{ a: 1 }, { a: 2 }] });
    const out = await runSqlQuery.execute({ sql: "SELECT * FROM t" }, ctx);
    expect(out.rowCount).toBe(2);
  });
});
