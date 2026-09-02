/**
 * src/constitution/axioms.ts
 *
 * 5 built-in Vauban axioms operationalised as discrete signal extractors.
 * Each axiom inspects a CycleSnapshot and returns a list of SignalPoints —
 * observable evidence items, each carrying a weight and a human-readable
 * evidence string.
 *
 * Axioms are intentionally deterministic and pure (no I/O).
 * They are consumed by scorer.ts and gate.ts.
 *
 * @module constitution/axioms
 */

import type { AxiomId, CycleSnapshot, SignalPoint } from "./types.js";

// ---------------------------------------------------------------------------
// Axiom interface
// ---------------------------------------------------------------------------

export interface Axiom {
  readonly id: AxiomId;
  readonly label: string;
  /**
   * Extract observable SignalPoints from a cycle.
   * Returns an empty array when no signals can be determined.
   */
  detect(cycle: CycleSnapshot): SignalPoint[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stringify an unknown value to a JSON-safe string for evidence. */
function stringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Flatten all step outputs and storedInputs into strings for scanning. */
function collectStepStrings(cycle: CycleSnapshot): string[] {
  const acc: string[] = [];
  for (const step of cycle.steps) {
    if (step.output !== undefined) acc.push(stringify(step.output));
    if (step.storedInput !== undefined) acc.push(stringify(step.storedInput));
  }
  return acc;
}

// ---------------------------------------------------------------------------
// PII patterns for Institutionnel detector v2
// ---------------------------------------------------------------------------

/**
 * French NIR (numéro de sécurité sociale) pattern.
 * Format: [12]\d{2}(0[1-9]|1[0-2])\d{2}\d{3}\d{3}\d{2}
 * Example: 1 85 12 75 108 111 45 → "185127510811145"
 */
const NIR_PATTERN = /\b[12]\d{2}(0[1-9]|1[0-2])\d{2}\d{3}\d{3}\d{2}\b/;

/**
 * IBAN pattern (FR-style: FR\d{2}\w{23}).
 * Detects French IBANs — also catches most EU IBANs by prefix.
 */
const IBAN_PATTERN = /\bFR\d{2}[0-9A-Z]{23}\b/i;

/**
 * Email pattern (RFC-loose — catches standard addresses).
 */
const EMAIL_PATTERN = /\b[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}\b/;

/**
 * French phone number pattern (mobile + landline).
 * Matches: 06/07/01-09 prefixes, with or without country code +33.
 */
const PHONE_FR_PATTERN = /(?:\+33|0033|0)[1-9](?:[.\- ]?\d{2}){4}/;

// ---------------------------------------------------------------------------
// Institutionnel — regulatory/credibility signals
// ---------------------------------------------------------------------------

/** Well-known regulatory scopes that signal explicit compliance alignment. */
const KNOWN_REGULATORY_SCOPES = new Set(["eIDAS", "gdpr", "ai-act-art-14", "eidas"]);

/**
 * Institutionnel axiom — v2.
 *
 * Signal hierarchy (descending severity):
 *   1. RSO veto flagged              → −1.0 (blocks approval)
 *   2. Unredacted PII in step output → −0.8 (severe regulatory violation)
 *   3. Explicit audit_trail_complete → +0.4 / absent → −0.3
 *   4. rootHash present (≥64 chars)  → +0.25 / absent → −0.5
 *   5. Regulatory scope declared     → +0.3 / absent → −0.1
 *   6. PII redacted (detected PII)   → +0.3
 *   7. No PII in payloads (clean)    → +0.2
 *   8. Step chain non-empty          → +0.15 / empty → −0.2
 *
 * PII patterns detected: email, French NIR, FR IBAN, French phone.
 * @public
 */
export const INSTITUTIONNEL: Axiom = {
  id: "Institutionnel",
  label: "Institutionnel",

  detect(cycle: CycleSnapshot): SignalPoint[] {
    const signals: SignalPoint[] = [];

    // --- Signal 1: RSO veto (strongest negative — vetoed cycles must not pass) ---
    if (cycle.metadata?.rso_veto === true) {
      signals.push({
        label: "rso_veto_flagged",
        weight: -1.0,
        evidence: "cycle.metadata.rso_veto=true — RSO has vetoed this cycle",
      });
    }

    // --- Signal 2: PII detection across all step payloads ---
    const stepStrings = collectStepStrings(cycle);

    /**
     * Tests all v2 PII patterns against a string.
     * Patterns: email, French NIR, FR IBAN, French phone.
     */
    const containsPii = (s: string): boolean =>
      EMAIL_PATTERN.test(s) ||
      NIR_PATTERN.test(s) ||
      IBAN_PATTERN.test(s) ||
      PHONE_FR_PATTERN.test(s);

    const hasPii = stepStrings.some(containsPii);
    if (hasPii) {
      if (cycle.metadata?.pii_redacted === true) {
        signals.push({
          label: "pii_redacted",
          weight: 0.3,
          evidence:
            "PII pattern detected (email/NIR/IBAN/phone FR) but metadata.pii_redacted=true — compliant handling",
        });
      } else {
        // Unredacted PII: strong negative (GDPR Article 5 violation)
        signals.push({
          label: "pii_unredacted",
          weight: -0.8,
          evidence:
            "PII pattern (email/NIR/IBAN/phone FR) found in step payload without pii_redacted=true — severe regulatory violation",
        });
      }
    } else {
      signals.push({
        label: "pii_clean",
        weight: 0.2,
        evidence: "No PII pattern (email/NIR/IBAN/phone FR) found in step payloads",
      });
    }

    // --- Signal 3: audit_trail_complete metadata flag ---
    // Explicit host-declared completeness outweighs rootHash alone.
    if (cycle.metadata?.audit_trail_complete === true) {
      signals.push({
        label: "audit_trail_complete",
        weight: 0.4,
        evidence: "metadata.audit_trail_complete=true — host asserts full step coverage",
      });
    } else if (cycle.metadata?.audit_trail_complete === false) {
      signals.push({
        label: "audit_trail_incomplete",
        weight: -0.3,
        evidence:
          "metadata.audit_trail_complete=false — host explicitly marks audit trail as incomplete",
      });
    }

    // --- Signal 4: rootHash present (structural audit trail integrity) ---
    if (cycle.rootHash && cycle.rootHash.length >= 64) {
      signals.push({
        label: "audit_trail_root_hash",
        weight: 0.25,
        evidence: `rootHash present (${cycle.rootHash.slice(0, 16)}…)`,
      });
    } else {
      signals.push({
        label: "audit_trail_root_hash",
        weight: -0.5,
        evidence: "rootHash absent or too short — audit trail integrity not verifiable",
      });
    }

    // --- Signal 5: regulatory_scope explicitly declared ---
    const scope = cycle.metadata?.regulatory_scope;
    if (typeof scope === "string" && scope.length > 0) {
      const normalized = scope.toLowerCase();
      if (KNOWN_REGULATORY_SCOPES.has(scope) || KNOWN_REGULATORY_SCOPES.has(normalized)) {
        signals.push({
          label: "regulatory_scope_known",
          weight: 0.3,
          evidence: `metadata.regulatory_scope="${scope}" is a recognized regulatory framework`,
        });
      } else {
        signals.push({
          label: "regulatory_scope_declared",
          weight: 0.1,
          evidence: `metadata.regulatory_scope="${scope}" declared (unrecognized scope — partial credit)`,
        });
      }
    } else {
      signals.push({
        label: "regulatory_scope_missing",
        weight: -0.1,
        evidence: "No regulatory_scope declared — regulatory alignment unverifiable",
      });
    }

    // --- Signal 6: step chain non-empty (completeness proxy) ---
    if (cycle.steps.length > 0) {
      signals.push({
        label: "step_chain_populated",
        weight: 0.15,
        evidence: `${cycle.steps.length} step(s) recorded`,
      });
    } else {
      signals.push({
        label: "step_chain_empty",
        weight: -0.2,
        evidence: "No steps recorded — audit trail is empty",
      });
    }

    return signals;
  },
};

// ---------------------------------------------------------------------------
// SOTA — state-of-art signals
// ---------------------------------------------------------------------------

const KNOWN_STALE_MODELS = new Set(["gpt-3", "gpt-3.5", "claude-1", "claude-2"]);
const PREFERRED_HASH_PRIMITIVES = new Set(["poseidon", "sha256", "sha-256"]);
const WEAK_HASH_PRIMITIVES = new Set(["md5", "sha1", "sha-1"]);
const ZK_UNSAFE_PRIMITIVES = new Set(["keccak256", "keccak-256"]);

/**
 * SOTA axiom.
 * Signals: model-version recency, hash primitive choices (Poseidon preferred,
 * keccak ZK-unsafe), post-quantum indicators.
 * @public
 */
export const SOTA: Axiom = {
  id: "SOTA",
  label: "SOTA",

  detect(cycle: CycleSnapshot): SignalPoint[] {
    const signals: SignalPoint[] = [];

    // Signal 1: model recency from step.model fields
    const stepModels: string[] = cycle.steps
      .filter((s) => s.model !== undefined)
      .map((s) => s.model?.name.toLowerCase() ?? "");

    const metaModel = cycle.metadata?.model_name?.toLowerCase() ?? "";

    const allModels: string[] = metaModel ? [...stepModels, metaModel] : stepModels;

    if (allModels.length > 0) {
      const isStale = (m: string) => [...KNOWN_STALE_MODELS].some((stale) => m.startsWith(stale));
      const staleModels = allModels.filter(isStale);
      if (staleModels.length > 0) {
        signals.push({
          label: "stale_model_version",
          weight: -0.5,
          evidence: `${staleModels.length} step(s) use known-stale model(s): ${staleModels.join(", ")}`,
        });
      } else {
        signals.push({
          label: "model_recency_ok",
          weight: 0.2,
          evidence: `Models in use: ${[...new Set(allModels)].join(", ")} — none flagged as stale`,
        });
      }
    }

    // Signal 2: hash primitive quality
    const primitive = cycle.metadata?.hash_primitive?.toLowerCase();
    if (primitive) {
      if (PREFERRED_HASH_PRIMITIVES.has(primitive)) {
        signals.push({
          label: "hash_primitive_sota",
          weight: 0.3,
          evidence: `hash_primitive="${primitive}" is ZK-friendly and SOTA`,
        });
      } else if (ZK_UNSAFE_PRIMITIVES.has(primitive)) {
        signals.push({
          label: "hash_primitive_zk_unsafe",
          weight: -0.4,
          evidence: `hash_primitive="${primitive}" is not ZK-friendly (higher prover cost) — prefer Poseidon`,
        });
      } else if (WEAK_HASH_PRIMITIVES.has(primitive)) {
        signals.push({
          label: "hash_primitive_weak",
          weight: -0.8,
          evidence: `hash_primitive="${primitive}" is cryptographically weak`,
        });
      } else {
        signals.push({
          label: "hash_primitive_unknown",
          weight: 0,
          evidence: `hash_primitive="${primitive}" — no SOTA classification available`,
        });
      }
    }

    // Signal 3: SLSA supply-chain level
    const slsa = cycle.metadata?.slsa_level;
    if (typeof slsa === "number") {
      if (slsa >= 3) {
        signals.push({
          label: "slsa_level_adequate",
          weight: 0.25,
          evidence: `SLSA level ${slsa} ≥ 3 — supply chain meets SOTA threshold`,
        });
      } else {
        signals.push({
          label: "slsa_level_low",
          weight: -0.25,
          evidence: `SLSA level ${slsa} < 3 — below SOTA supply-chain threshold`,
        });
      }
    }

    return signals;
  },
};

// ---------------------------------------------------------------------------
// Robuste — engineering quality signals
// ---------------------------------------------------------------------------

/**
 * Regex that detects leaked secrets in serialised output.
 * @public
 */
export const SECRET_PATTERN = /secret|api[_-]?key|password|token=/i;

/**
 * Robuste axiom.
 * Signals: timeouts configured, explicit error paths, absence of debug artifacts,
 * supply-chain SLSA hint, leaked secrets.
 * @public
 */
export const ROBUSTE: Axiom = {
  id: "Robuste",
  label: "Robuste",

  detect(cycle: CycleSnapshot): SignalPoint[] {
    const signals: SignalPoint[] = [];

    // Signal 1: timeouts configured
    if (cycle.metadata?.timeouts_configured === true) {
      signals.push({
        label: "timeouts_configured",
        weight: 0.3,
        evidence: "metadata.timeouts_configured=true",
      });
    } else if (cycle.metadata?.timeouts_configured === false) {
      signals.push({
        label: "timeouts_missing",
        weight: -0.5,
        evidence: "metadata.timeouts_configured=false — external calls lack timeouts",
      });
    }

    // Signal 2: error paths explicit
    if (cycle.metadata?.error_paths_explicit === true) {
      signals.push({
        label: "error_paths_explicit",
        weight: 0.25,
        evidence: "metadata.error_paths_explicit=true",
      });
    } else if (cycle.metadata?.error_paths_explicit === false) {
      signals.push({
        label: "error_paths_missing",
        weight: -0.4,
        evidence: "metadata.error_paths_explicit=false — silent failure risk",
      });
    }

    // Signal 3: no leaked secrets in step outputs
    const stepStrings = collectStepStrings(cycle);
    const secretLeak = stepStrings.some((s) => SECRET_PATTERN.test(s));
    if (secretLeak) {
      signals.push({
        label: "secret_leaked_in_output",
        weight: -1.0,
        evidence:
          "Step output matches secret/api_key/password/token= pattern — potential secret leak",
      });
    } else {
      signals.push({
        label: "no_secret_leak",
        weight: 0.2,
        evidence: "No secret-like patterns detected in step outputs",
      });
    }

    // Signal 4: scope id declared (discipline signal)
    if (cycle.scope_id) {
      signals.push({
        label: "scope_id_declared",
        weight: 0.15,
        evidence: `scope_id="${cycle.scope_id}" declared`,
      });
    } else {
      signals.push({
        label: "scope_id_missing",
        weight: -0.1,
        evidence: "No scope_id — scope boundary undeclared",
      });
    }

    return signals;
  },
};

// ---------------------------------------------------------------------------
// AntiFragile — resilience signals
// ---------------------------------------------------------------------------

/**
 * AntiFragile axiom.
 * Signals: fallback exists, multi-source funding/data, idempotence.
 * @public
 */
export const ANTI_FRAGILE: Axiom = {
  id: "AntiFragile",
  label: "AntiFragile",

  detect(cycle: CycleSnapshot): SignalPoint[] {
    const signals: SignalPoint[] = [];

    // Signal 1: fallback path exists
    if (cycle.metadata?.has_fallback === true) {
      signals.push({
        label: "fallback_exists",
        weight: 0.4,
        evidence: "metadata.has_fallback=true",
      });
    } else if (cycle.metadata?.has_fallback === false) {
      signals.push({
        label: "no_fallback",
        weight: -0.4,
        evidence: "metadata.has_fallback=false — single point of failure",
      });
    }

    // Signal 2: multi-source
    const sourcesCount = cycle.metadata?.source_count ?? 0;
    if (sourcesCount >= 2) {
      signals.push({
        label: "multi_source",
        weight: 0.3,
        evidence: `metadata.source_count=${sourcesCount} — multi-source redundancy present`,
      });
    } else if (sourcesCount === 1) {
      signals.push({
        label: "single_source",
        weight: -0.2,
        evidence: "metadata.source_count=1 — single data/funding source",
      });
    }

    // Signal 3: idempotent operation
    if (cycle.metadata?.is_idempotent === true) {
      signals.push({
        label: "idempotent",
        weight: 0.3,
        evidence: "metadata.is_idempotent=true — side-effects are recoverable",
      });
    } else if (cycle.metadata?.is_idempotent === false) {
      signals.push({
        label: "non_idempotent",
        weight: -0.3,
        evidence: "metadata.is_idempotent=false — non-idempotent operations increase fragility",
      });
    }

    return signals;
  },
};

// ---------------------------------------------------------------------------
// Profitable — cost discipline signals
// ---------------------------------------------------------------------------

/**
 * Profitable axiom.
 * Signals: budget respected, walk-away discipline (no budget overrun).
 * @public
 */
export const PROFITABLE: Axiom = {
  id: "Profitable",
  label: "Profitable",

  detect(cycle: CycleSnapshot): SignalPoint[] {
    const signals: SignalPoint[] = [];

    // Signal 1: budget respected
    const overrun = cycle.budgetUsdSpent - cycle.budgetUsdMax;
    if (overrun > 0) {
      signals.push({
        label: "budget_overrun",
        weight: -0.8,
        evidence: `budgetUsdSpent=${cycle.budgetUsdSpent.toFixed(4)} > budgetUsdMax=${cycle.budgetUsdMax.toFixed(4)} — overrun by $${overrun.toFixed(4)}`,
      });
    } else {
      const utilisation = cycle.budgetUsdMax > 0 ? cycle.budgetUsdSpent / cycle.budgetUsdMax : 0;
      signals.push({
        label: "budget_respected",
        weight: 0.4,
        evidence: `budget utilisation ${(utilisation * 100).toFixed(1)}% — within bounds`,
      });
    }

    // Signal 2: zero-cost guard (no LLM cost means no work done — suspicious)
    const totalCost = cycle.steps.reduce((acc, s) => acc + (s.costUsd ?? 0), 0);
    if (totalCost === 0 && cycle.steps.length > 0) {
      signals.push({
        label: "zero_cost_cycle",
        weight: -0.1,
        evidence: "Total costUsd=0 across all steps — cost tracking may be missing",
      });
    } else if (totalCost > 0) {
      signals.push({
        label: "cost_tracked",
        weight: 0.1,
        evidence: `Total costUsd=${totalCost.toFixed(6)} — cost tracking active`,
      });
    }

    return signals;
  },
};

// ---------------------------------------------------------------------------
// Built-in axiom registry
// ---------------------------------------------------------------------------

/** @public */
export const BUILT_IN_AXIOMS: ReadonlyArray<Axiom> = [
  INSTITUTIONNEL,
  SOTA,
  ROBUSTE,
  ANTI_FRAGILE,
  PROFITABLE,
] as const;
