/**
 * Parité des noms d'attributs wire avec `@vauban-org/assurance-grade`.
 *
 * Les deux paquets déclarent LOCALEMENT les mêmes noms d'attributs (décision
 * design 2026-09-01 : zéro arête de dépendance en production entre le paquet
 * privé et le SDK ; la duplication de trois littéraux de chaîne est pinnée ici,
 * via la devDependency workspace). Si un côté renomme un attribut wire, ce
 * test casse.
 */

import {
  VAUBAN_ASSURANCE_CONE_MIN as ENGINE_CONE_MIN,
  VAUBAN_ASSURANCE_GRADE as ENGINE_GRADE,
  VAUBAN_LINK_TYPE as ENGINE_LINK_TYPE,
} from "@vauban-org/assurance-grade";
import { describe, expect, it } from "vitest";
import {
  VAUBAN_ASSURANCE_CONE_MIN,
  VAUBAN_ASSURANCE_GRADE,
  VAUBAN_LINK_TYPE,
} from "../src/otel/attributes.js";

describe("wire attribute name parity (agent-sdk <-> assurance-grade)", () => {
  it("vauban.assurance.grade matches", () => {
    expect(VAUBAN_ASSURANCE_GRADE).toBe(ENGINE_GRADE);
  });
  it("vauban.assurance.cone_min matches", () => {
    expect(VAUBAN_ASSURANCE_CONE_MIN).toBe(ENGINE_CONE_MIN);
  });
  it("vauban.link.type matches", () => {
    expect(VAUBAN_LINK_TYPE).toBe(ENGINE_LINK_TYPE);
  });
});
