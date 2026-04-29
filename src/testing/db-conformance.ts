/**
 * DbPort conformance suite.
 *
 * Contract: query(sql, params?) resolves to { rows: T[], rowCount?: number }.
 * Minimal — subset of pg.Client/Pool. Impls may support additional methods
 * but MUST provide this one.
 */

import type { DbPort } from "../ports/db.js";
import type { ConformanceRunner } from "./runner.js";

export interface DbConformanceConfig {
  describe: ConformanceRunner["describe"];
  it: ConformanceRunner["it"];
  // biome-ignore lint/suspicious/noExplicitAny: matcher shape
  expect: any;
  factory: () => Promise<DbPort> | DbPort;
  /**
   * A SQL string that returns at least one row deterministically.
   * Defaults to `SELECT 1 AS n` which works on pg.
   */
  selectOneSql?: string;
}

export function dbPortConformance(config: DbConformanceConfig): void {
  const { describe, it, expect, factory } = config;
  const selectOneSql = config.selectOneSql ?? "SELECT 1 AS n";

  describe("DbPort conformance", () => {
    it("query resolves with { rows: [] } shape", async () => {
      const db = await factory();
      const result = await db.query(selectOneSql);
      expect(Array.isArray(result.rows)).toBe(true);
    });

    it("query with params binds without error", async () => {
      const db = await factory();
      // Using $1 placeholder — impls must accept params array even if empty.
      const result = await db.query(selectOneSql, []);
      expect(Array.isArray(result.rows)).toBe(true);
    });
  });
}
