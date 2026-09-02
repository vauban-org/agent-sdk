/**
 * Matrice de PARCOURS UTILISATEUR pour le verdict de memoire non observe.
 *
 * Le parcours modelise est toujours le meme, et c'est celui du founder : il pose
 * a son assistante une question dont la reponse ne peut venir que d'une memoire
 * durable (« comment je prends mon cafe ? », « quelle est ma date de naissance ? »).
 * Ce qui change d'un cas a l'autre, c'est ce que l'assistante FAIT avant de
 * repondre. Les tests sont nommes par la PROMESSE tenue au founder, jamais par la
 * mecanique interne : ce qu'on defend, c'est qu'il ne croie jamais sa memoire vide
 * sur la foi d'une recherche qui n'a pas eu lieu.
 *
 * Nominal = elle cherche vraiment. Alternatif = elle ne cherche pas mais le dit
 * honnetement. Exception = elle ne cherche pas et rend quand meme un verdict.
 */

import { describe, expect, it } from "vitest";
import {
  isMemoryLookupTool,
  negativeMemoryVerdicts,
  unobservedMemoryClaimWarning,
} from "../src/remote/gateway/unobserved-memory-claim.js";

const LOOKED = { lookupRan: true };
const DID_NOT_LOOK = { lookupRan: false };

describe("parcours nominal ; elle a vraiment cherche", () => {
  it("un vide constate apres recherche est rendu tel quel, sans avertissement", () => {
    const answer =
      "J'ai cherche dans mes notes : je n'ai rien trouve sur tes preferences cafe. Dis-moi comment tu le prends ?";
    expect(unobservedMemoryClaimWarning(answer, LOOKED)).toBeNull();
  });

  it("une reponse trouvee en memoire passe sans avertissement", () => {
    const answer = "Tu le prends noir, sans sucre. C'est note depuis le 12 mai.";
    expect(unobservedMemoryClaimWarning(answer, LOOKED)).toBeNull();
  });
});

describe("parcours alternatif ; elle n'a pas cherche, et elle le dit", () => {
  it("« je ne sais pas » reste autorise : c'est l'inconnu rendu honnetement", () => {
    const answer = "Je ne sais pas comment tu prends ton cafe. Tu me le dis ?";
    expect(unobservedMemoryClaimWarning(answer, DID_NOT_LOOK)).toBeNull();
  });

  it("« je n'ai pas encore verifie » n'est pas un verdict d'absence", () => {
    const answer = "Je n'ai pas encore verifie dans ma memoire, je regarde tout de suite.";
    expect(unobservedMemoryClaimWarning(answer, DID_NOT_LOOK)).toBeNull();
  });

  it("une reponse ordinaire sans rapport avec la memoire passe", () => {
    const answer = "Il est 18h02. Tu veux que je te rappelle quelque chose ?";
    expect(unobservedMemoryClaimWarning(answer, DID_NOT_LOOK)).toBeNull();
  });
});

describe("parcours d'exception ; elle rend un verdict qu'elle n'a pas etabli", () => {
  it("l'incident du cafe (2026-08-31) est signale au founder", () => {
    const answer =
      "Laisse-moi verifier dans ma memoire ce que je sais sur ton cafe. Une seconde.\n\n" +
      "Je n'ai rien trouve dans mes notes sur tes preferences cafe, c'est peut-etre la " +
      "premiere fois qu'on en parle, ou je ne l'ai jamais enregistre.";
    const warning = unobservedMemoryClaimWarning(answer, DID_NOT_LOOK);
    expect(warning).not.toBeNull();
    expect(warning).toContain("no memory lookup ran");
  });

  it("l'incident de la date de naissance (2026-08-30) est signale au founder", () => {
    const answer = "Je n'ai visiblement jamais archive ce detail te concernant.";
    expect(unobservedMemoryClaimWarning(answer, DID_NOT_LOOK)).not.toBeNull();
  });

  it("le meme defaut en anglais est signale", () => {
    expect(
      unobservedMemoryClaimWarning("I found nothing in my notes about that.", DID_NOT_LOOK),
    ).not.toBeNull();
    expect(
      unobservedMemoryClaimWarning("I never saved that preference, sorry.", DID_NOT_LOOK),
    ).not.toBeNull();
  });

  it("l'avertissement CITE la phrase incriminee, pour etre verifiable", () => {
    const warning = unobservedMemoryClaimWarning(
      "Je n'ai rien trouve dans mes notes a ce sujet.",
      DID_NOT_LOOK,
    );
    expect(warning).toContain("dans mes notes");
  });
});

describe("ce qui compte comme « avoir regarde »", () => {
  it("les outils de consultation de memoire sont reconnus", () => {
    for (const name of [
      "brain_query",
      "mcp__brain__query_knowledge",
      "mcp__brain__recall_and_answer",
      "mcp__brain__working_memory_get",
      "mcp__brain__episodic_query",
      "recall_memory",
      "mcp__command-center__recall_memory",
      "mcp__brain__memory_status",
    ]) {
      expect(isMemoryLookupTool(name), name).toBe(true);
    }
  });

  it("ECRIRE en memoire n'est pas y avoir regarde", () => {
    // brain_store ecrit ; il n'etablit aucune absence. Le compter fermerait la
    // garde sur « j'ai note ta preference, mais je n'avais rien avant ».
    expect(isMemoryLookupTool("brain_store")).toBe(false);
    expect(isMemoryLookupTool("mcp__brain__archive_knowledge")).toBe(false);
  });

  it("un outil sans rapport ne vaut pas observation de la memoire", () => {
    for (const name of ["run_bash", "web_search", "send_email", "get_weather"]) {
      expect(isMemoryLookupTool(name), name).toBe(false);
    }
  });
});

describe("sens de l'erreur assume", () => {
  it("quand elle a regarde, on se tait meme sur un verdict tres negatif", () => {
    // Un faux avertissement serait a son tour un verdict non etabli. La garde
    // penche vers le silence, jamais vers l'accusation.
    const answer = "Rien dans ma memoire, rien dans mes notes, je n'ai jamais archive ca.";
    expect(negativeMemoryVerdicts(answer).length).toBeGreaterThan(0);
    expect(unobservedMemoryClaimWarning(answer, LOOKED)).toBeNull();
  });
});
