/**
 * advisory.ts ; the AdvisoryClaim type boundary (I2).
 *
 * A learned / predictive value (an LLM note, an ML score) enters a loop as a
 * typed `AdvisoryClaim` and is FORBIDDEN BY TYPE from reaching a gate or the A3
 * decision domain. This is the same exclusion theorem Vauban applies to
 * disclosure-derived entities in the CvRDT merge domain, applied to prediction:
 * a property of the algebra, not a convention. A deterministic gate signature
 * only ever accepts plain deterministic data ; `assertNotAdvisory` is the runtime
 * defence-in-depth backstop behind the type wall.
 *
 * Backbone (martingale-MCP, ref to verify): bounded context + stable tools +
 * periodic verification keep distortion linear, NOT exponential ; the advisory is
 * recorded provenance, never a gating operator (cf. the LLM-out-of-the-proof-
 * perimeter invariant: a replay replays the RECORDED advisory, it does not call
 * the model).
 *
 * Promoted into the published SDK per ADR-ECO-101 (I2 GATE). L1 evidence: the BTC
 * best-execution pilot (command-center apps/agents/btc-execution, commit 31fdd269
 * ; the I2 type-boundary unit contract + the ORIENT advisory wiring). Reusable by
 * any agent that mixes an advisory (LLM / ML) signal with a deterministic gate.
 */

export interface AdvisoryProvenance {
  /** Origin of the advice, e.g. "llm" | "ml-model". */
  readonly source: string;
  readonly model?: string;
  readonly version?: string;
  /** Self-reported confidence in [0, 1] ; advisory only, never gates. */
  readonly confidence: number;
}

/**
 * A non-deterministic, predictive value. The `kind` discriminant is the type
 * wall: gate signatures accept deterministic data, never `AdvisoryClaim`, so
 * passing one is a compile error.
 */
export interface AdvisoryClaim<T> {
  readonly kind: "advisory";
  readonly value: T;
  readonly provenance: AdvisoryProvenance;
}

/** Construct an AdvisoryClaim. */
export function advisoryClaim<T>(value: T, provenance: AdvisoryProvenance): AdvisoryClaim<T> {
  return { kind: "advisory", value, provenance };
}

/** Runtime guard: is `x` a branded AdvisoryClaim? */
export function isAdvisory(x: unknown): x is AdvisoryClaim<unknown> {
  return typeof x === "object" && x !== null && (x as { kind?: unknown }).kind === "advisory";
}

/**
 * Defence-in-depth: throw if an advisory value reaches a deterministic gate. The
 * type wall is primary ; this catches an `unknown` / `any` that slipped past it.
 */
export function assertNotAdvisory(x: unknown, where: string): void {
  if (isAdvisory(x)) {
    throw new TypeError(
      `${where}: an AdvisoryClaim must never reach the deterministic gate domain (ADR-ECO-101 I2)`,
    );
  }
}
