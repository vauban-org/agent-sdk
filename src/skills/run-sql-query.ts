/**
 * run_sql_query — read-only SQL on the agent's scoped DB (cc:read scope).
 *
 * Pre-check: rejects any query that contains a write keyword
 * (INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/GRANT/CREATE) outside of
 * a string literal.
 *
 * NOTE: this is a defence-in-depth check; DB-level read-only role is
 * still required at the host wiring layer.
 *
 * @public
 */
import { z } from "zod";
import type { Skill, SkillContext } from "../orchestration/ooda/skills.js";
import { SqlReadOnlyViolation } from "./errors.js";
import { withSkillSpan } from "./_otel.js";

const inputSchema = z
  .object({
    sql: z.string().min(1).max(8_000),
    params: z.array(z.unknown()).max(64).optional(),
  })
  .strict();
type RunSqlQueryInput = z.infer<typeof inputSchema>;

export interface RunSqlQueryOutput {
  rows: object[];
  rowCount: number;
}

const WRITE_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "ALTER",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
  "CREATE",
  "REPLACE",
  "MERGE",
  "CALL",
  "VACUUM",
  "REINDEX",
  "COPY",
];

/** Strips PostgreSQL string literals + line/block comments before keyword scan. */
function stripStringsAndComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " ");
}

export function isReadOnlySql(sql: string): boolean {
  const stripped = stripStringsAndComments(sql).toUpperCase();
  for (const kw of WRITE_KEYWORDS) {
    const re = new RegExp(`(^|[^A-Z_])${kw}([^A-Z_]|$)`);
    if (re.test(stripped)) return false;
  }
  return true;
}

export const runSqlQuery: Skill<RunSqlQueryInput, RunSqlQueryOutput> = {
  name: "run_sql_query",
  inputSchema,
  async execute(input, ctx: SkillContext): Promise<RunSqlQueryOutput> {
    if (!isReadOnlySql(input.sql)) {
      throw new SqlReadOnlyViolation(input.sql);
    }
    if (ctx.isReplay) {
      const mock = ctx.dryRunMocks["run_sql_query"];
      if (mock) return mock(input) as RunSqlQueryOutput;
      return { rows: [], rowCount: 0 };
    }
    return withSkillSpan("run_sql_query", async () => {
      const result = await ctx.db.query<object>(input.sql, input.params);
      return {
        rows: result.rows,
        rowCount: result.rowCount ?? result.rows.length,
      };
    });
  },
};
