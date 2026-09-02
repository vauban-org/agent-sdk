/**
 * remote/gateway/unobserved-memory-claim ; un verdict sur la memoire, rendu sans
 * avoir regarde.
 *
 * POURQUOI CE FICHIER EXISTE. Le 2026-08-31 a 16:02 UTC, le founder demande a son
 * assistante « comment je prends mon cafe ? ». Elle repond :
 *
 *   Laisse-moi verifier dans ma memoire ce que je sais sur ton cafe. Une seconde.
 *   [...] Je n'ai rien trouve dans mes notes sur tes preferences cafe -- c'est
 *   peut-etre la premiere fois qu'on en parle, ou je ne l'ai jamais enregistre.
 *
 * Le run tient en UNE etape et n'execute AUCUN outil (mesure dans les journaux de
 * la passerelle : quatre tours, zero appel, contexte de 0,9k jeton). Elle annonce
 * une recherche, ne la fait pas, puis rapporte son resultat.
 *
 * C'est le meme motif interdit d'ADR-ECO-149 que `unexecuted-tool-call.ts`, sous
 * sa forme la plus difficile a voir : la veille, le modele ECRIVAIT la syntaxe de
 * l'outil, ce qui laissait une trace reconnaissable. Ici il n'ecrit que de la
 * prose. Rien, dans le message, ne distingue « j'ai cherche et il n'y a rien » de
 * « je n'ai pas cherche ». Le founder en tire la meme conclusion dans les deux
 * cas : ma memoire est vide. C'est ce qui a produit sa phrase « elle ne se
 * souvient de rien a mon sujet » alors que son Brain porte 72 entrees.
 *
 * CE QU'ON DETECTE, ET CE QU'ON LAISSE PASSER. Uniquement les verdicts
 * NEGATIFS sur l'etat de la memoire stockee. Pourquoi pas les positifs : une
 * affirmation positive sans appel d'outil est le plus souvent une reprise de la
 * conversation visible, ce qui est legitime ; l'annoter produirait un faux
 * avertissement, c'est-a-dire exactement le defaut combattu. Le prejudice mesure
 * est entierement du cote negatif (« je n'ai jamais archive ce detail »,
 * « je n'ai rien trouve dans mes notes »), les deux fois sur une recherche
 * inexistante.
 *
 * LA LIGNE, ET ELLE EST PRECISE. « Je ne sais pas » reste autorise et n'est PAS
 * detecte : c'est un enonce sur soi, le troisieme etat rendu honnetement. Ce qui
 * est interdit, c'est de convertir cet inconnu en un etabli : « il n'y a rien
 * dans mes notes » est un constat, et un constat exige d'avoir regarde.
 *
 * SENS DE L'ERREUR, ASSUME. `isMemoryLookupTool` est volontairement LARGE : sur
 * un nom d'outil ambigu, on conclut qu'une recherche a eu lieu, donc on se tait.
 * Le sens inverse -- annoter « ceci n'a pas ete observe » un message qui l'avait
 * ete -- serait a son tour un verdict non etabli. Une garde contre les faux
 * verdicts ne peut pas se permettre d'en produire.
 *
 * @public
 */

/**
 * Un outil qui CONSULTE une memoire durable. Large a dessein (voir l'en-tete) :
 * couvre les natifs (`brain_query`), les MCP (`mcp__brain__query_knowledge`,
 * `recall_and_answer`, `working_memory_get`, `episodic_query`) et les variantes
 * a venir, sans exiger qu'on tienne une liste a jour -- une liste maintenue a la
 * main est un avertissement, pas une garde.
 */
export function isMemoryLookupTool(toolName: string): boolean {
  const n = toolName.toLowerCase();
  if (/(^|_)recall|memory_get|memory_list|memory_status|get_context/.test(n)) return true;
  if (/(brain|knowledge|episodic|memor|souvenir)/.test(n)) {
    return /(query|search|get|list|read|recall|find|fetch|status)/.test(n);
  }
  return false;
}

/**
 * Verdicts negatifs sur la memoire stockee, en francais et en anglais. Chaque
 * motif exige DEUX choses : la negation d'un resultat, et le support consulte
 * (memoire, notes, archives, Brain). « Je ne sais pas », qui n'a pas de support,
 * ne matche aucun.
 */
const NEGATIVE_MEMORY_VERDICT: readonly RegExp[] = [
  // « je n'ai rien trouve dans mes notes », « aucune trace dans ma memoire »
  /\b(?:rien|aucune?)\b[^.!?\n]{0,60}\b(?:dans|en)\s+(?:ma|mes|mon|le|la)\s+(?:memoire|mémoire|notes?|archives?|souvenirs?|brain)\b/i,
  // « je n'ai rien trouve », borne au meme support par la suite de phrase
  /\bje\s+n[e']\s*ai\s+(?:rien|aucune?[^.!?\n]{0,30})\s+(?:trouve|trouvé|retrouve|retrouvé)\b/i,
  // « je ne l'ai jamais enregistre », « je n'ai VISIBLEMENT jamais archive ce
  // detail » : l'adverbe intercale est la forme reellement rendue au founder le
  // 2026-08-30, et la premiere version de ce motif la laissait passer. On tolere
  // jusqu'a deux mots de part et d'autre de la negation.
  // `encore` est exclu a dessein : « je ne l'ai pas encore note » annonce une
  // action a venir, ce n'est pas un constat sur ce qui est stocke.
  /\bje\s+n[e']\s*(?:l['e]\s*)?ai\s+(?:(?!encore\b)\w+\s+){0,2}?(?:jamais|pas)\s+(?:(?!encore\b)\w+\s+){0,2}?(?:archive|archivé|enregistre|enregistré|note|noté|sauvegarde|sauvegardé|stocke|stocké|garde|gardé)\b/i,
  // anglais : « nothing in my notes », « no record in my memory »
  /\b(?:nothing|no\s+(?:record|trace|note|entry|memory))\b[^.!?\n]{0,60}\b(?:in|from)\s+(?:my|the)\s+(?:memory|notes?|records?|archives?|brain)\b/i,
  // anglais : « I never saved that », « I don't have anything stored »
  // `d?` : « I never SAVED that » etait la forme naturelle, et la borne de mot
  // apres `save` la rejetait.
  /\bi\s+(?:never|did\s+not|didn't)\s+(?:saved?|stored?|recorded?|archived?|noted?)\b/i,
  /\bi\s+(?:do\s+not|don't)\s+have\s+(?:anything|any\s+\w+)\s+(?:stored|recorded|saved|on\s+file)\b/i,
];

/**
 * Les fragments de phrase qui portent un verdict negatif sur la memoire.
 * Vide quand le message n'en porte aucun.
 */
export function negativeMemoryVerdicts(content: string): string[] {
  const found: string[] = [];
  for (const re of NEGATIVE_MEMORY_VERDICT) {
    const m = re.exec(content);
    if (m !== null) found.push(m[0].trim());
  }
  return found;
}

/**
 * Prefixe d'avertissement, ou `null` quand il n'y a rien a signaler.
 *
 * `lookupRan` vient de la boucle, seule a savoir ce qui a REELLEMENT tourne : le
 * rendu ne voit que du texte, et un texte ne dit pas ce qu'il a fait. C'est
 * l'invariant d'ADR-ECO-148 applique ici -- la verification appartient a
 * l'executant, jamais au lecteur en aval.
 */
export function unobservedMemoryClaimWarning(
  content: string,
  opts: { lookupRan: boolean },
): string | null {
  if (opts.lookupRan) return null;
  const verdicts = negativeMemoryVerdicts(content);
  if (verdicts.length === 0) return null;
  return `⚠️ This answer states what is NOT in memory ("${verdicts[0]}") but no memory lookup ran in this turn. That absence was not observed ; treat it as unknown, not as empty.`;
}
