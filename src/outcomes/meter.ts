/**
 * AgentMeter — intra-network agent outcome ledger.
 *
 * Sprint-563: B7 — append-only ledger + verifyChain + OutcomeGate.
 * x402 inter-agent scope deferred to sprint-564 C1.
 *
 * recordRun(runId, agentId, outcome) → appends to ledger.
 * getBalance(agentId, period) → MeterBalance (total runs, total value, net).
 * verifyChain(agentId, since?) → valid + firstInvalidAt (R8 non-bloquant #3).
 * OutcomeGate.validate(outcome, threshold) → chargeableCents.
 * @public
 */

export interface MeterEntry {
  agentId: string;
  runId: string;
  valueCents: number;
  timestamp: number;
  /** Hash of previous entry (chain integrity). */
  prevHash: string;
  /** Hash of this entry. */
  hash: string;
}

/** @public */
export interface MeterBalance {
  agentId: string;
  totalRuns: number;
  totalValueCents: number;
  netValueCents: number;
  firstRunAt: number;
  lastRunAt: number;
}

/** @public */
export interface MeterVerifyResult {
  valid: boolean;
  firstInvalidAt?: number;
  reason?: string;
  totalEntries: number;
}

function hashEntry(entry: Omit<MeterEntry, "hash">): string {
  const { hash: _, ...rest } = entry as MeterEntry;
  return JSON.stringify(rest);
}

/**
 * AgentMeter — append-only ledger for agent outcomes.
 * Internal scope: intra-network only (no x402 cross-agent payments).
 * @public
 */
export class AgentMeter {
  private ledger: MeterEntry[] = [];

  /** Record a run outcome. Appends to the ledger with chain hash. */
  recordRun(runId: string, agentId: string, valueCents: number): MeterEntry {
    const prevHash = this.ledger.length > 0 ? this.ledger[this.ledger.length - 1].hash : "genesis";

    const rawEntry = {
      agentId,
      runId,
      valueCents,
      timestamp: Date.now(),
      prevHash,
    };

    const entry: MeterEntry = {
      ...rawEntry,
      hash: hashEntry(rawEntry),
    };

    this.ledger.push(entry);
    return entry;
  }

  /** Get balance for an agent within a time period. */
  getBalance(agentId: string, since?: number): MeterBalance {
    const runs = this.ledger.filter(
      (e) => e.agentId === agentId && (since === undefined || e.timestamp >= since),
    );

    if (runs.length === 0) {
      return {
        agentId,
        totalRuns: 0,
        totalValueCents: 0,
        netValueCents: 0,
        firstRunAt: 0,
        lastRunAt: 0,
      };
    }

    const netValueCents = runs.reduce((s, e) => s + e.valueCents, 0);
    const totalValueCents = runs.reduce((s, e) => s + Math.abs(e.valueCents), 0);
    return {
      agentId,
      totalRuns: runs.length,
      totalValueCents,
      netValueCents,
      firstRunAt: runs[0].timestamp,
      lastRunAt: runs[runs.length - 1].timestamp,
    };
  }

  /** Verify chain integrity. Returns first invalid entry index or null if all valid. */
  verifyChain(agentId?: string, since?: number): MeterVerifyResult {
    const entries = this.ledger.filter(
      (e) =>
        (agentId === undefined || e.agentId === agentId) &&
        (since === undefined || e.timestamp >= since),
    );

    if (entries.length === 0) {
      return { valid: true, totalEntries: 0 };
    }

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const expectedHash = hashEntry(entry);

      // Check hash consistency
      if (entry.hash !== expectedHash) {
        const originalIndex = this.ledger.indexOf(entry);
        return {
          valid: false,
          firstInvalidAt: originalIndex,
          reason: `Hash mismatch at entry ${i}: expected ${expectedHash}, got ${entry.hash}`,
          totalEntries: entries.length,
        };
      }

      // Check chain continuity
      if (i > 0) {
        const prevEntry = entries[i - 1];
        if (entry.prevHash !== prevEntry.hash) {
          const originalIndex = this.ledger.indexOf(entry);
          return {
            valid: false,
            firstInvalidAt: originalIndex,
            reason: `Chain broken at entry ${i}: prevHash ${entry.prevHash} != ${prevEntry.hash}`,
            totalEntries: entries.length,
          };
        }
      }
    }

    return { valid: true, totalEntries: entries.length };
  }

  /** Export full ledger (for storage/persistence). */
  export(): MeterEntry[] {
    return [...this.ledger];
  }

  /** Import ledger entries (from storage). */
  import(entries: MeterEntry[]): void {
    this.ledger = [...entries];
  }
}

// ─── OutcomeGate ─────────────────────────────────────────────────────────────

/** @public */
export interface OutcomeGateResult {
  allowed: boolean;
  chargeableCents: number;
  reason?: string;
}

/** @public */
export interface OutcomeGateOptions {
  /** Maximum value per run (cents). Reject if outcome exceeds this. */
  maxValueCents?: number;
  /** Minimum value per run (cents). Reject if outcome is below this. */
  minValueCents?: number;
  /** Maximum cumulative spend in period (cents). */
  maxCumulativeCents?: number;
}

/**
 * OutcomeGate — validates agent outcomes against thresholds.
 * Used to gate agent actions before execution.
 * @public
 */
export function validateOutcome(
  outcome: { valueCents: number },
  currentBalance: MeterBalance,
  opts: OutcomeGateOptions = {},
): OutcomeGateResult {
  const chargeableCents = Math.max(0, outcome.valueCents);

  if (opts.minValueCents !== undefined && chargeableCents < opts.minValueCents) {
    return {
      allowed: false,
      chargeableCents: 0,
      reason: `Outcome value ${chargeableCents} below minimum ${opts.minValueCents}`,
    };
  }

  if (opts.maxValueCents !== undefined && chargeableCents > opts.maxValueCents) {
    return {
      allowed: false,
      chargeableCents: 0,
      reason: `Outcome value ${chargeableCents} exceeds maximum ${opts.maxValueCents}`,
    };
  }

  if (
    opts.maxCumulativeCents !== undefined &&
    currentBalance.totalValueCents + chargeableCents > opts.maxCumulativeCents
  ) {
    return {
      allowed: false,
      chargeableCents: 0,
      reason: `Cumulative spend ${currentBalance.totalValueCents + chargeableCents} exceeds max ${opts.maxCumulativeCents}`,
    };
  }

  return { allowed: true, chargeableCents };
}
