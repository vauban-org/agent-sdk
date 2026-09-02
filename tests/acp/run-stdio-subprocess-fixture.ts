// Fixture pour run-stdio.test.ts ("vrai subprocess"). Ce fichier n'est PAS un
// test vitest : il est execute comme un vrai processus enfant (via `node`,
// qui supporte nativement le type-stripping TypeScript depuis la v23.6) par
// `spawn()`, exactement comme le ferait un futur binaire `preste acp`. Il
// cable `runAcpStdioServer` sur `process.stdin`/`process.stdout` reels, sans
// aucune injection de test : c'est la preuve la plus forte que le transport
// fonctionne au-dela des tests unitaires en memoire.
import { runAcpStdioServer } from "../../src/acp/run-stdio.js";

await runAcpStdioServer({
  agentInfo: { name: "preste-fixture", version: "0.0.0-test" },
  stdin: process.stdin,
  stdout: process.stdout,
});
// Pas de process.exit() explicite : une fois stdin ferme et la boucle
// d'evenements vide, le processus se termine naturellement, ce qui garantit
// que tout ce qui a ete ecrit sur stdout est bien flush (contrairement a un
// process.exit() immediat, qui peut tronquer une ecriture pipe en attente).
