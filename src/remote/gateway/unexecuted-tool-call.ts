/**
 * remote/gateway/unexecuted-tool-call ; detecter un appel d'outil ECRIT, jamais execute.
 *
 * POURQUOI CE FICHIER EXISTE. Le 2026-08-30, l'assistante du founder a rendu
 * deux tours consécutifs de cette forme, en une seule etape chacun :
 *
 *   {"action": "query_brain_and_memory", "queries": [{"tool": "brain_query", ...}]}
 *   <brain_query q="date de naissance Fabien" />
 *   Rien n'est ressorti de la premiere recherche. Je tente avec d'autres termes.
 *
 * Le modele a ECRIT l'invocation au lieu de l'emettre comme appel structure. La
 * boucle, ne voyant aucun `toolCalls`, a traite ce texte comme la reponse
 * finale ; le modele a ensuite invente le resultat (« rien n'est ressorti ») et
 * raisonne dessus. Le founder a donc recu une conclusion tiree d'une recherche
 * QUI N'A JAMAIS EU LIEU, presentee comme une observation.
 *
 * C'est le motif interdit d'ADR-ECO-149 sous sa forme la plus couteuse : une
 * surface qui rend un verdict qu'elle n'a pas etabli. Trois minutes plus tot, le
 * meme agent avait REELLEMENT cherche (trois etapes) et trouve la bonne reponse ;
 * rien ne distinguait les deux messages a la lecture.
 *
 * CE QUE CE MODULE NE FAIT PAS. Il ne corrige pas la cause cote modele et ne
 * supprime rien : il ANNOTE. Un message annote reste lisible en entier, mais son
 * lecteur sait que ce qu'il contient n'a pas ete observe. Supprimer le message
 * priverait le founder d'information ; le laisser nu le laisserait croire une
 * recherche fictive. L'annotation est le seul des trois choix qui n'ajoute pas
 * de mensonge.
 *
 * @public
 */

/**
 * Balise pseudo-XML dont le nom ressemble a un outil (`snake_case`, au moins un
 * souligne). `<brain_query q="..." />`, `<episodic_query />`. La prose normale
 * n'en contient pas ; un nom sans souligne (`<b>`, `<div>`) est ignore.
 */
const XMLISH_TOOL = /<([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b[^>]*>/g;

/**
 * Objet JSON decrivant un appel : `"tool": "brain_query"`. Plus specifique que
 * le simple nom d'outil, qui peut legitimement apparaitre dans une phrase.
 */
const JSON_TOOL = /"tool"\s*:\s*"([a-z][a-z0-9_]*)"/g;

/**
 * Noms d'outils invoques EN TEXTE dans `content`, dedupliques et ordonnes.
 * Vide quand le message est une reponse normale.
 */
export function unexecutedToolCallMarkers(content: string): string[] {
  const found = new Set<string>();
  for (const re of [XMLISH_TOOL, JSON_TOOL]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null = re.exec(content);
    while (m !== null) {
      if (m[1]) found.add(m[1]);
      m = re.exec(content);
    }
  }
  return [...found].sort();
}

/**
 * Prefixe d'avertissement, ou `null` si le message est propre.
 *
 * Le texte nomme les outils concernes : « quelque chose ne va pas » n'aide
 * personne, « brain_query n'a pas tourne » se verifie.
 */
export function unexecutedToolCallWarning(content: string): string | null {
  const names = unexecutedToolCallMarkers(content);
  if (names.length === 0) return null;
  return `⚠️ This answer contains a tool invocation written as TEXT and never run (${names.join(", ")}). Anything it concludes from that call was not observed. Ask again before trusting it.`;
}
