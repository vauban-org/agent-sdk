/**
 * MemoryHITLStateStore — in-process HITL state store.
 *
 * Suitable for tests, local dev, and single-instance deployments.
 * Multi-instance prod deployments must use PostgresHITLStateStore.
 *
 * @public
 */

import {
  HITLNotFoundError,
  type HITLPort,
  type HITLRequest,
  type HITLState,
  validateTransition,
} from "../../ports/hitl.js";

interface MemoryEntry {
  request: HITLRequest;
  state: HITLState;
  decision?: string;
  decidedBy?: string;
  decidedAt?: Date;
  executedAt?: Date;
}

const POLL_INTERVAL_MS = 100;

/** @public */
export class MemoryHITLStateStore implements HITLPort {
  readonly #store = new Map<string, MemoryEntry>();

  async request(req: HITLRequest): Promise<string> {
    this.#store.set(req.id, { request: req, state: "pending" });
    return req.id;
  }

  async getState(id: string): Promise<HITLState> {
    const entry = this.#store.get(id);
    if (!entry) throw new HITLNotFoundError(id);
    return entry.state;
  }

  async await(id: string, timeoutMs?: number): Promise<HITLState> {
    const deadline = timeoutMs != null ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;

    for (;;) {
      const state = await this.getState(id);
      if (state !== "pending") return state;
      if (Date.now() >= deadline) return state;

      // Wait one poll tick (or remaining budget, whichever is shorter)
      const remaining = deadline - Date.now();
      const wait = Math.min(POLL_INTERVAL_MS, remaining > 0 ? remaining : 0);
      await new Promise<void>((resolve) => setTimeout(resolve, wait));

      // Re-check deadline after sleeping
      if (Date.now() >= deadline) return await this.getState(id);
    }
  }

  async resolve(id: string, decision: "approved" | "rejected", by: string): Promise<void> {
    const entry = this.#store.get(id);
    if (!entry) throw new HITLNotFoundError(id);
    validateTransition(entry.state, decision);
    entry.state = decision;
    entry.decision = decision;
    entry.decidedBy = by;
    entry.decidedAt = new Date();
  }

  async expire(id: string): Promise<void> {
    const entry = this.#store.get(id);
    if (!entry) throw new HITLNotFoundError(id);
    validateTransition(entry.state, "expired");
    entry.state = "expired";
  }

  /**
   * Called by runExpireJob to expire all overdue pending requests.
   * Not part of HITLPort — called via the _expireOverdue duck-type hook.
   */
  async _expireOverdue(): Promise<void> {
    const now = new Date();
    for (const [id, entry] of this.#store.entries()) {
      if (entry.state === "pending" && new Date(entry.request.deadline) < now) {
        entry.state = "expired";
        // Best-effort: if validateTransition would throw, we already checked state=pending above
        void id; // keep the binding in scope
      }
    }
  }
}
