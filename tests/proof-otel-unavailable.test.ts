/**
 * toOtelSpan quand le moteur de grading est ABSENT.
 *
 * Le moteur n'est plus référencé par agent-sdk : un hôte l'INJECTE via
 * `setAssuranceGradingEngine` (port explicite). Tout install hors du workspace
 * vauban-org — c'est-à-dire tout consommateur du paquet publié — n'injecte
 * jamais rien : c'est l'état par défaut du module, reproduit ici en forçant
 * l'injection à `undefined` (robuste même si un autre test du même processus
 * avait injecté). Contrat de dégradation : les attributs de grade sont OMIS
 * (pas de "A0" fabriqué — A0 est un verdict « zéro évidence », pas « moteur
 * absent ») et le marqueur explicite `vauban.assurance.unavailable: true` est
 * posé.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { setAssuranceGradingEngine, toOtelSpan } from "../src/proof/otel.js";
import {
  VAUBAN_ASSURANCE_CONE_MIN,
  VAUBAN_ASSURANCE_GRADE,
  VAUBAN_ASSURANCE_UNAVAILABLE,
} from "../src/otel/attributes.js";
import type { RunStep } from "../src/proof/types.js";

beforeAll(() => {
  setAssuranceGradingEngine(undefined);
});

function step(overrides: Partial<RunStep> = {}): RunStep {
  return {
    id: "step-1",
    run_id: "run-1",
    step_index: 0,
    type: "action",
    status: "completed",
    started_at: "2026-09-01T00:00:00Z",
    leaf_hash_poseidon: "0xabc",
    ...overrides,
  } as RunStep;
}

describe("toOtelSpan without the grading engine", () => {
  it("omits grade attributes and sets the explicit unavailable marker", () => {
    const span = toOtelSpan(step());
    expect(span.attributes[VAUBAN_ASSURANCE_UNAVAILABLE]).toBe(true);
    expect(VAUBAN_ASSURANCE_GRADE in span.attributes).toBe(false);
    expect(VAUBAN_ASSURANCE_CONE_MIN in span.attributes).toBe(false);
  });

  it("never renders the absence as a grade — no A0..A3 value appears", () => {
    // Un step qui, moteur présent, serait gradé A1 (leaf hash présent) : son
    // absence de mesure ne doit produire AUCUNE valeur de l'échelle.
    const span = toOtelSpan(step(), [step()]);
    const values = Object.values(span.attributes);
    for (const grade of ["A0", "A1", "A2", "A3"]) {
      expect(values).not.toContain(grade);
    }
    expect(span.attributes[VAUBAN_ASSURANCE_UNAVAILABLE]).toBe(true);
  });

  it("keeps every non-assurance attribute intact", () => {
    const span = toOtelSpan(step());
    expect(span.attributes["gen_ai.system"]).toBe("vauban-command-center");
    expect(span.attributes["run.id"]).toBe("run-1");
    expect(span.attributes["proof.leaf_hash_poseidon"]).toBe("0xabc");
  });
});
