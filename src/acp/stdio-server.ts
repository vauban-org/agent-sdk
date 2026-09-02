/**
 * Boucle serveur ACP sur stdio (tranche 2) : relie le framing ndjson
 * (framing.ts), l'enveloppe JSON-RPC (jsonrpc.ts) et la negociation
 * `initialize` (initialize.ts) en une seule boucle testable de bout en bout,
 * sans encore spawner de vrai subprocess ni cabler `AgentLoop`.
 *
 * Portee de cette tranche : preste joue le role "agent" ACP. `initialize`
 * repond reellement ; toute autre methode (session/new, session/prompt...)
 * repond method-not-found, honnetement, puisque rien d'autre n'est cable.
 * Il n'y a donc PAS de garde stateful "avant/apres initialize" : ce serait
 * une machine a etats qui ne protegerait rien de reel tant que le reste du
 * cycle de vie n'existe pas.
 *
 * Codes d'erreur JSON-RPC 2.0 standard (spec JSON-RPC, pas ACP-specifique) :
 * -32700 parse error, -32601 method not found. On n'utilise que ceux-la ici ;
 * -32600/-32602/-32603 attendront un besoin reel plutot que d'etre poses par
 * anticipation.
 */

import { AcpFrameDecoder, encodeAcpFrame } from "./framing.js";
import type { AcpImplementation } from "./initialize.js";
import { negotiateAcpInitialize } from "./initialize.js";
import { AcpProtocolError, parseAcpMessage, serializeAcpMessage } from "./jsonrpc.js";
import type { AcpMessageId, AcpResponse } from "./jsonrpc.js";

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_METHOD_NOT_FOUND = -32601;

export interface AcpStdioAgentServerOptions {
  /** Identite de preste annoncee dans la reponse `initialize`. */
  readonly agentInfo: AcpImplementation;
  /** Ecrit une trame deja encodee sur le flux de sortie reel (stdout du
   * subprocess agent, ou tout sink equivalent en test). Jamais appele pour
   * une notification entrante ou une reponse entrante (JSON-RPC : on ne
   * repond jamais a ce qui n'attend pas de reponse). */
  readonly write: (frame: string) => void;
}

/**
 * Boucle serveur ACP pilotee par pushes de chunks (mirroir de l'API
 * `AcpFrameDecoder.push`, pour rester testable sans vrai subprocess ni flux
 * Node reel). `push()` traite chaque chunk d'octets recu, `end()` signale la
 * fin propre du flux. Le cablage a de vrais flux stdio (Node ou subprocess)
 * vit dans `run-stdio.ts` (tranche 3), pas ici : cette classe reste agnostique
 * du transport concret.
 */
export class AcpStdioAgentServer {
  readonly #decoder = new AcpFrameDecoder();
  readonly #opts: AcpStdioAgentServerOptions;

  constructor(opts: AcpStdioAgentServerOptions) {
    this.#opts = opts;
  }

  /** Pousse un chunk d'octets recu du flux d'entree ; traite chaque ligne
   * complete qu'il permet de former, dans l'ordre d'arrivee. */
  push(chunk: Uint8Array): void {
    for (const line of this.#decoder.push(chunk)) {
      this.#handleLine(line);
    }
  }

  /** Signale la fin propre du flux d'entree (EOF : fermeture du subprocess
   * client ou fin de stdin). Un editeur qui clot sa derniere ligne sans `\n`
   * final (fermeture immediate apres l'ecriture, sans flush explicite du
   * cote client) laisserait sinon cette ligne coincee dans le decodeur pour
   * toujours : on la recupere via `AcpFrameDecoder.flush()` et on la traite
   * comme n'importe quelle autre ligne complete. Idempotent : rien a faire
   * si aucune ligne n'est en attente. */
  end(): void {
    const trailing = this.#decoder.flush();
    if (trailing !== undefined) {
      this.#handleLine(trailing);
    }
  }

  #handleLine(line: string): void {
    // Une ligne vide (deux `\n` consecutifs) n'est pas un message JSON-RPC :
    // on l'ignore silencieusement plutot que de fabriquer une erreur de
    // parse sur du "rien", au meme titre qu'un flux qui tolere des lignes
    // blanches entre messages.
    if (line.length === 0) {
      return;
    }
    let message: ReturnType<typeof parseAcpMessage>;
    try {
      message = parseAcpMessage(line);
    } catch (err) {
      if (err instanceof AcpProtocolError) {
        // Frontiere hostile (Zero Trust) : une ligne illisible ne fait jamais
        // planter la boucle. On ne peut pas recuperer d'id sur un JSON qui
        // n'a pas pu etre parse ou qui n'a pas la forme attendue ; JSON-RPC
        // 2.0 prescrit `id: null` dans ce cas precis.
        this.#respond({
          jsonrpc: "2.0",
          id: null,
          error: { code: JSONRPC_PARSE_ERROR, message: err.message },
        });
        return;
      }
      throw err;
    }

    // Une reponse entrante (result/error) n'a de sens que si CE serveur a
    // lui-meme emis une requete vers le client (permission, fs/*...), ce
    // qu'aucune methode cablee ici ne fait encore. Rien a correler : no-op
    // silencieux, jamais une erreur (la forme est valide, juste inattendue
    // pour cette tranche).
    if ("result" in message || "error" in message) {
      return;
    }

    // Notification (pas d'id) : JSON-RPC 2.0 interdit toute reponse, meme
    // une erreur, a une notification. Methode inconnue = ignoree en silence.
    if (!("id" in message)) {
      return;
    }

    // Requete avec id : la seule methode reellement cablee est `initialize`.
    if (message.method === "initialize") {
      const result = negotiateAcpInitialize(
        message.params as Parameters<typeof negotiateAcpInitialize>[0],
        this.#opts.agentInfo,
      );
      this.#respond({ jsonrpc: "2.0", id: message.id, result });
      return;
    }

    this.#respondMethodNotFound(message.id, message.method);
  }

  #respondMethodNotFound(id: AcpMessageId, method: string): void {
    this.#respond({
      jsonrpc: "2.0",
      id,
      error: { code: JSONRPC_METHOD_NOT_FOUND, message: `methode ACP non geree : ${method}` },
    });
  }

  #respond(response: AcpResponse): void {
    this.#opts.write(encodeAcpFrame(serializeAcpMessage(response)));
  }
}
