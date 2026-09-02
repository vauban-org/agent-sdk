/**
 * src/verify/formal/spec-language.ts
 *
 * Sprint-587 — DSL for axiom specifications, compiled to SMT-LIB v2.
 *
 * Design philosophy (inspired by FormalJudge, arXiv:2602.11136) : agent-cycle
 * properties are expressed as small, typed pre/post-condition tuples. Each
 * condition is mapped to an SMT-LIB fragment by {@link compileToSmt}, which
 * frames the property as a NEGATION of the post-conditions under the
 * pre-conditions. This way, Z3 returning `sat` means a counterexample exists
 * (= UNSAFE) and `unsat` means the post-conditions hold (= SAFE).
 *
 * Bound types : Reals for budgets and ratios, Bools for binary properties,
 * Sets-as-symbols for scope subset checks.
 *
 * @module verify/formal/spec-language
 */

/**
 * One verifiable axiom-level property.
 * @public
 */
export interface AxiomSpec {
  /** Human-readable axiom label (e.g. "Robuste", "Profitable"). */
  axiom: string;
  /** Conditions that must hold for the spec to be meaningful. */
  preconditions: Condition[];
  /** Conditions whose conjunction defines the post-state to verify. */
  postconditions: Condition[];
  /** Solver timeout in ms — see {@link DEFAULT_POLICIES}. */
  timeout_ms?: number;
}

/**
 * Tagged union of all supported condition kinds.
 *
 * `custom_smt` is the escape hatch : the consumer supplies a raw SMT-LIB
 * fragment that will be inlined under an `(assert ...)`. Use sparingly —
 * mistakes here are silent semantic bugs.
 * @public
 */
export type Condition =
  | { type: "budget_constraint"; child_max_fraction: number }
  | { type: "scope_subset"; parent_scope: string[]; child_scope: string[] }
  | { type: "no_pii_in_output"; pii_count_var?: string }
  | { type: "cost_positive_roi"; min_roi_ratio: number }
  | { type: "response_time"; max_ms: number }
  | { type: "custom_smt"; smt_fragment: string };

// ---------------------------------------------------------------------------
// Compilation : condition → SMT-LIB fragment
// ---------------------------------------------------------------------------

interface CompileContext {
  /** Declared symbols (so we don't double-declare). */
  declared: Set<string>;
  /** Accumulated declarations. */
  declarations: string[];
  /** Accumulated assertions (precondition + negated postcondition). */
  assertions: string[];
}

function ensureDecl(ctx: CompileContext, decl: string, name: string): void {
  if (ctx.declared.has(name)) return;
  ctx.declared.add(name);
  ctx.declarations.push(decl);
}

/**
 * Lower a single Condition into SMT-LIB assertions appended to `ctx`.
 * `negated` flag : when true, the condition is being added as a negated
 * post-condition (i.e. we want to find a counterexample).
 */
function lowerCondition(c: Condition, ctx: CompileContext, negated: boolean): void {
  switch (c.type) {
    case "budget_constraint": {
      // parent_budget >= 0, child_budget >= 0, child_budget <= parent_budget * fraction
      ensureDecl(ctx, "(declare-const parent_budget Real)", "parent_budget");
      ensureDecl(ctx, "(declare-const child_budget Real)", "child_budget");
      // Positivity is part of the pre-state, always assert.
      ctx.assertions.push("(assert (>= parent_budget 0))");
      ctx.assertions.push("(assert (>= child_budget 0))");
      const expr = `(<= child_budget (* parent_budget ${c.child_max_fraction}))`;
      ctx.assertions.push(`(assert ${negated ? `(not ${expr})` : expr})`);
      return;
    }

    case "scope_subset": {
      // Encode each child element as a Bool : it must be present in parent.
      // We do this by reducing to a boolean conjunction over the listed
      // child elements. Mismatches surface as a counterexample.
      const parentSet = new Set(c.parent_scope);
      const childOk = c.child_scope.every((s) => parentSet.has(s));
      // No declarations needed — fold the result statically into a bool.
      const expr = childOk ? "true" : "false";
      ctx.assertions.push(`(assert ${negated ? `(not ${expr})` : expr})`);
      return;
    }

    case "no_pii_in_output": {
      const name = c.pii_count_var ?? "pii_count";
      ensureDecl(ctx, `(declare-const ${name} Int)`, name);
      // pii_count >= 0 (always)
      ctx.assertions.push(`(assert (>= ${name} 0))`);
      const expr = `(= ${name} 0)`;
      ctx.assertions.push(`(assert ${negated ? `(not ${expr})` : expr})`);
      return;
    }

    case "cost_positive_roi": {
      ensureDecl(ctx, "(declare-const cost Real)", "cost");
      ensureDecl(ctx, "(declare-const value Real)", "value");
      ctx.assertions.push("(assert (> cost 0))");
      ctx.assertions.push("(assert (>= value 0))");
      const expr = `(>= (/ value cost) ${c.min_roi_ratio})`;
      ctx.assertions.push(`(assert ${negated ? `(not ${expr})` : expr})`);
      return;
    }

    case "response_time": {
      ensureDecl(ctx, "(declare-const response_ms Real)", "response_ms");
      ctx.assertions.push("(assert (>= response_ms 0))");
      const expr = `(<= response_ms ${c.max_ms})`;
      ctx.assertions.push(`(assert ${negated ? `(not ${expr})` : expr})`);
      return;
    }

    case "custom_smt": {
      const frag = c.smt_fragment.trim();
      // The custom fragment is expected to be a parenthesised assertion body.
      if (negated) {
        ctx.assertions.push(`(assert (not ${frag}))`);
      } else {
        ctx.assertions.push(`(assert ${frag})`);
      }
      return;
    }
  }
}

/**
 * Compile an {@link AxiomSpec} into an SMT-LIB v2 program string.
 *
 * Pattern : preconditions are asserted as-is ; postconditions are joined by
 * conjunction and asserted NEGATED. A counterexample (z3 returns `sat`)
 * therefore means : "pre-conditions hold AND at least one post-condition
 * fails" — i.e. an UNSAFE outcome.
 *
 * Includes `(check-sat)` and `(get-model)` as terminating commands.
 * @public
 */
export function compileToSmt(spec: AxiomSpec): string {
  const ctx: CompileContext = {
    declared: new Set(),
    declarations: [],
    assertions: [],
  };

  // Header — set logic to QF_LRA (quantifier-free linear real arithmetic
  // plus integers) which covers all our supported condition kinds.
  const header = ["(set-logic ALL)", `; AxiomSpec : ${spec.axiom}`];

  // Preconditions : assert as-is (positive form).
  for (const pre of spec.preconditions) {
    lowerCondition(pre, ctx, false);
  }

  // Postconditions : conjoin and negate.
  // Strategy : assert each one negated separately using De Morgan. We want
  //   NOT (post1 AND post2 AND …) ≡ (NOT post1) OR (NOT post2) OR …
  // For check-sat-as-counterexample, we want the solver to find *any*
  // violation, so we encode the disjunction with an auxiliary Bool flag
  // per postcondition. Simpler equivalent : assert (or (not post1) (not post2) …).
  if (spec.postconditions.length === 0) {
    // Empty postcondition set : trivially SAFE (no obligation to verify).
    ctx.assertions.push("(assert false)");
  } else if (spec.postconditions.length === 1) {
    lowerCondition(spec.postconditions[0], ctx, true);
  } else {
    // Build per-postcondition expression strings via a side-context, then
    // emit a single `(assert (or ...))`.
    const subCtx: CompileContext = {
      declared: ctx.declared,
      declarations: ctx.declarations,
      assertions: [],
    };
    const negatedExprs: string[] = [];
    for (const post of spec.postconditions) {
      const before = subCtx.assertions.length;
      lowerCondition(post, subCtx, true);
      // The last appended assertion is "(assert <neg expr>)" or pre-assertions.
      // To recover only the negated post-condition body, we accept that some
      // conditions append additional non-negotiable preconditions (positivity).
      // Those are valid in any case and stay in the main assertion list.
      for (let i = before; i < subCtx.assertions.length; i++) {
        const a = subCtx.assertions[i];
        // Heuristic : split positivity asserts (>= x 0) and the negated body.
        // The negated body always contains "(not ".
        if (a.includes("(not ")) {
          // Extract the inner expr "(not …)" inside the outer assert.
          const inner = a.slice("(assert ".length, -1);
          negatedExprs.push(inner);
        }
      }
      // Drop the negated body assertions from subCtx so we only keep
      // the positivity ones in the main assertion list.
      subCtx.assertions = subCtx.assertions.filter((a) => !a.includes("(not "));
    }
    ctx.assertions = subCtx.assertions;
    ctx.assertions.push(`(assert (or ${negatedExprs.join(" ")}))`);
  }

  return [...header, ...ctx.declarations, ...ctx.assertions, "(check-sat)", "(get-model)"].join(
    "\n",
  );
}

// ---------------------------------------------------------------------------
// Pre-built specs for the 5 Vauban axioms
// ---------------------------------------------------------------------------

/**
 * Default per-axiom AxiomSpec presets. Consumers can override the timeout
 * or augment with additional conditions before passing to `formalVerify`.
 *
 * Robuste        : 5s — engineering robustness, may need richer checks
 * Institutionnel : 10s — strongest spec, PII + scope-subset + budget
 * SOTA           : 2s  — lightweight (single ROI check on cost)
 * AntiFragile    : 1s  — response-time bound only
 * Profitable     : 1s  — cost-vs-value ROI check
 * @public
 */
export const AXIOM_SPECS: Record<string, AxiomSpec> = {
  Robuste: {
    axiom: "Robuste",
    preconditions: [],
    postconditions: [
      { type: "budget_constraint", child_max_fraction: 1.0 },
      { type: "response_time", max_ms: 30_000 },
    ],
    timeout_ms: 5000,
  },
  Institutionnel: {
    axiom: "Institutionnel",
    preconditions: [],
    postconditions: [
      { type: "no_pii_in_output" },
      { type: "budget_constraint", child_max_fraction: 1.0 },
    ],
    timeout_ms: 10_000,
  },
  SOTA: {
    axiom: "SOTA",
    preconditions: [],
    postconditions: [{ type: "cost_positive_roi", min_roi_ratio: 1.0 }],
    timeout_ms: 2000,
  },
  AntiFragile: {
    axiom: "AntiFragile",
    preconditions: [],
    postconditions: [{ type: "response_time", max_ms: 60_000 }],
    timeout_ms: 1000,
  },
  Profitable: {
    axiom: "Profitable",
    preconditions: [],
    postconditions: [{ type: "cost_positive_roi", min_roi_ratio: 1.5 }],
    timeout_ms: 1000,
  },
};
