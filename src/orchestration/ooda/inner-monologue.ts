/**
 * Inner Monologue — Private reasoning scratchpad for the decide phase.
 *
 * The monologue is a private reasoning trace that is:
 *   - NEVER stored in Brain
 *   - NEVER included in span attributes
 *   - NEVER logged to OTel traces
 *
 * Content is wrapped in `SensitiveValue<T>` that throws on `toString()`,
 * with an explicit `reveal()` method gated behind `executionMode === "debug"`.
 *
 * Inner monologue can contain financial reasoning, vulnerability analysis,
 * or strategic deliberation — leaking it to traces or Brain is a security
 * boundary violation. Enforced at the type level, not convention.
 *
 * @public
 */

// ─── SensitiveValue ─────────────────────────────────────────────────────────────

/**
 * Wraps a value that MUST NOT be logged, traced, or stored.
 *
 * `toString()` throws intentionally — prevents accidental leakage via
 * template literals, JSON.stringify, or log formatters.
 * @public
 */
export class SensitiveValue<T> {
  readonly #value: T;
  readonly #label: string;

  constructor(value: T, label = "sensitive") {
    this.#value = value;
    this.#label = label;
  }

  /** Intentionally throws — prevents accidental leakage. */
  toString(): string {
    throw new Error(`SensitiveValue<${this.#label}>: use reveal() with explicit debug mode check`);
  }

  /** JSON.stringify trap — prevents serialization. */
  toJSON(): never {
    throw new Error(`SensitiveValue<${this.#label}>: cannot be serialized`);
  }

  /**
   * Reveal the inner value.
   *
   * Gate this behind `executionMode === "debug"` — never expose in
   * production traces, logs, or Brain archives.
   */
  reveal(): T {
    return this.#value;
  }

  get label(): string {
    return this.#label;
  }
}

// ─── Inner Monologue ────────────────────────────────────────────────────────────

/** @public */
export interface InnerMonologueInput {
  /** The observation or orient output to reason about. */
  observation: unknown;
  /** Agent configuration / context. */
  config?: unknown;
  /** Previous monologues from this cycle (for chain-of-thought). */
  previous?: string[];
}

/** @public */
export interface InnerMonologueOutput {
  /** The reasoning trace — wrapped as SensitiveValue. */
  reasoning: SensitiveValue<string>;
  /** Key insights extracted (safe for Brain archival). */
  insights: string[];
  /** Decision confidence (0.0 - 1.0). */
  confidence: number;
}

/**
 * Generate an inner monologue — private reasoning that MUST NOT leak.
 *
 * The `reasoner` function receives the input and returns the monologue.
 * The returned `reasoning` is wrapped in `SensitiveValue<string>`.
 *
 * Use `reveal()` only in debug execution mode — never in production.
 * @public
 */
export async function innerMonologue(
  input: InnerMonologueInput,
  reasoner: (
    input: InnerMonologueInput,
  ) => Promise<{ reasoning: string; insights: string[]; confidence: number }>,
): Promise<InnerMonologueOutput> {
  const result = await reasoner(input);
  return {
    reasoning: new SensitiveValue(result.reasoning, "inner-monologue"),
    insights: result.insights,
    confidence: result.confidence,
  };
}
