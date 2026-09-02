/**
 * Point d'entree stdio reel pour AcpStdioAgentServer (tranche 3).
 *
 * Pourquoi ce fichier existe : `AcpStdioAgentServer` (stdio-server.ts,
 * tranche 2) est pilote par des appels directs a `push(chunk)`, ce qui le
 * rend testable sans vrai subprocess mais ne le relie a aucun flux d'octets
 * reel. Il n'existait donc aucun point d'entree qui lise `process.stdin` et
 * ecrive sur `process.stdout` pour de vrai. Ce module comble exactement ce
 * trou, rien de plus.
 *
 * Les flux sont injectes en parametre (`stdin`/`stdout`) plutot que codes en
 * dur sur `process.stdin`/`process.stdout` : un `PassThrough` de
 * `node:stream` suffit alors a tester ce cablage avec de vrais flux Node en
 * memoire, sans spawner de subprocess, tout en gardant la fonction utilisable
 * telle quelle par un futur vrai binaire (`preste acp`, hors scope ici).
 *
 * Portee strictement transport : aucune notion de session ACP (session/new,
 * session/prompt, session/update...) n'est cablee ici, ni `AgentLoop`. Voir
 * `stdio-server.ts` pour ce qui repond reellement (`initialize`) et ce qui ne
 * repond encore que `method-not-found`, honnetement.
 */

import type { AcpImplementation } from "./initialize.js";
import { AcpStdioAgentServer } from "./stdio-server.js";

export interface RunAcpStdioServerOptions {
  /** Identite de preste annoncee dans la reponse `initialize`. */
  readonly agentInfo: AcpImplementation;
  /** Flux d'entree reel : `process.stdin` en production, un `PassThrough` en
   * test. N'importe quel `ReadableStream` Node qui emet des chunks
   * `Buffer`/`Uint8Array` (ou `string`, convertie en UTF-8) convient. */
  readonly stdin: NodeJS.ReadableStream;
  /** Flux de sortie reel : `process.stdout` en production, un `PassThrough`
   * en test. Chaque trame ACP encodee (voir `framing.ts`) y est ecrite telle
   * quelle. */
  readonly stdout: NodeJS.WritableStream;
}

/**
 * Cable un `AcpStdioAgentServer` a de vrais flux Node : chaque chunk lu sur
 * `stdin` est pousse dans le serveur, chaque trame produite est ecrite sur
 * `stdout`. Retourne une promesse qui se resout quand `stdin` se termine
 * (evenement `"end"`, fermeture propre du flux), apres avoir flush() le
 * decodeur au cas ou une derniere ligne serait restee en attente sans `\n`
 * final (voir `AcpStdioAgentServer.end()`). Se rejette si `stdin` emet une
 * erreur : une frontiere hostile (Zero Trust) ne doit jamais laisser la
 * promesse pendante indefiniment.
 */
export function runAcpStdioServer(opts: RunAcpStdioServerOptions): Promise<void> {
  const server = new AcpStdioAgentServer({
    agentInfo: opts.agentInfo,
    write: (frame) => {
      opts.stdout.write(frame);
    },
  });

  return new Promise((resolve, reject) => {
    opts.stdin.on("data", (chunk: Buffer | string) => {
      // `Buffer` est deja une sous-classe de `Uint8Array` (accepte tel quel
      // par `push`) ; le cas `string` ne se presente que si l'appelant a mis
      // le flux en mode encodage explicite (`setEncoding`), a couvrir quand
      // meme plutot que de supposer un seul mode possible.
      server.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
    });
    opts.stdin.on("end", () => {
      server.end();
      resolve();
    });
    opts.stdin.on("error", (err: Error) => {
      reject(err);
    });
  });
}
