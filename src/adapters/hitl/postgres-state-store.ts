/**
 * PostgresHITLStateStore — Postgres-backed HITL state store.
 *
 * Uses SELECT FOR UPDATE for atomic state transitions (no lost-update races).
 * Requires the hitl_requests table from migration 039_hitl_requests.sql.
 *
 * Constructor: { db: DbPort } — compatible with pg.Pool / pg.Client.
 *
 * @public
 */

import type { DbPort } from "../../ports/db.js";
import {
  HITLNotFoundError,
  type HITLPort,
  type HITLRequest,
  type HITLState,
  validateTransition,
} from "../../ports/hitl.js";

interface HITLRow {
  id: string;
  state: HITLState;
}

/** @public */
export class PostgresHITLStateStore implements HITLPort {
  readonly #db: DbPort;

  constructor({ db }: { db: DbPort }) {
    this.#db = db;
  }

  async request(req: HITLRequest): Promise<string> {
    await this.#db.query(
      `INSERT INTO hitl_requests
         (id, agent_source, question, context, options, channel, state, deadline, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)`,
      [
        req.id,
        req.agentSource,
        req.question,
        JSON.stringify(req.context),
        req.options,
        req.channel,
        req.deadline,
        req.tenantId ?? null,
      ],
    );
    return req.id;
  }

  async getState(id: string): Promise<HITLState> {
    const result = await this.#db.query<HITLRow>(
      "SELECT id, state FROM hitl_requests WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    if (!row) throw new HITLNotFoundError(id);
    return row.state;
  }

  async await(id: string, timeoutMs?: number): Promise<HITLState> {
    const deadline = timeoutMs != null ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
    const POLL_MS = 500;

    for (;;) {
      const state = await this.getState(id);
      if (state !== "pending") return state;
      if (Date.now() >= deadline) return state;

      const remaining = deadline - Date.now();
      const wait = Math.min(POLL_MS, remaining > 0 ? remaining : 0);
      await new Promise<void>((resolve) => setTimeout(resolve, wait));

      if (Date.now() >= deadline) return await this.getState(id);
    }
  }

  async resolve(id: string, decision: "approved" | "rejected", by: string): Promise<void> {
    await this.#db.query("BEGIN", []);
    try {
      const result = await this.#db.query<HITLRow>(
        "SELECT id, state FROM hitl_requests WHERE id = $1 FOR UPDATE",
        [id],
      );
      const row = result.rows[0];
      if (!row) {
        await this.#db.query("ROLLBACK", []);
        throw new HITLNotFoundError(id);
      }
      validateTransition(row.state, decision);

      await this.#db.query(
        `UPDATE hitl_requests
            SET state = $1, decision = $2, decided_by = $3, decided_at = NOW()
          WHERE id = $4`,
        [decision, decision, by, id],
      );
      await this.#db.query("COMMIT", []);
    } catch (err) {
      await this.#db.query("ROLLBACK", []).catch(() => undefined);
      throw err;
    }
  }

  async expire(id: string): Promise<void> {
    await this.#db.query("BEGIN", []);
    try {
      const result = await this.#db.query<HITLRow>(
        "SELECT id, state FROM hitl_requests WHERE id = $1 FOR UPDATE",
        [id],
      );
      const row = result.rows[0];
      if (!row) {
        await this.#db.query("ROLLBACK", []);
        throw new HITLNotFoundError(id);
      }
      validateTransition(row.state, "expired");

      await this.#db.query(`UPDATE hitl_requests SET state = 'expired' WHERE id = $1`, [id]);
      await this.#db.query("COMMIT", []);
    } catch (err) {
      await this.#db.query("ROLLBACK", []).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Expire all pending requests whose deadline has passed.
   * Called by runExpireJob via the _expireOverdue duck-type hook.
   */
  async _expireOverdue(): Promise<void> {
    await this.#db.query(
      `UPDATE hitl_requests
          SET state = 'expired'
        WHERE state = 'pending' AND deadline < NOW()`,
      [],
    );
  }
}
