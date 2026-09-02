/**
 * Framing des messages ACP sur un flux stdio.
 *
 * Pourquoi ce fichier existe : contrairement au LSP (Content-Length en
 * en-tete, comme `packages/cli/src/delivery/drive-server.ts` en HTTP ou
 * `packages/usine-engine/src/sandbox/k8s-api.ts` le font pour d'autres
 * protocoles de ce depot), ACP encadre chaque message JSON-RPC par un simple
 * saut de ligne (ndjson : un objet JSON complet par ligne, `\n` en
 * terminateur). Verifie directement dans le SDK TypeScript officiel
 * (@agentclientprotocol/sdk, src/line-buffer.ts : `LineBuffer` scinde le
 * flux d'octets sur 0x0a), ce n'est PAS une hypothese, c'est le mecanisme
 * reellement implemente par l'ecosysteme ACP. On reprend donc ce choix de
 * framing plutot que d'introduire du Content-Length qui n'existe pas cote
 * ACP.
 *
 * Ce module ne fait que le decoupage en lignes completes ; le parsing JSON
 * de chaque ligne est la responsabilite de `jsonrpc.ts`.
 */

const NEWLINE = 0x0a;

/**
 * Encode un message ACP deja serialise en une trame prete a ecrire sur le
 * flux stdio (le JSON ne doit lui-meme jamais contenir de `\n` brut :
 * `JSON.stringify` ne produit pas de saut de ligne litteral dans la sortie).
 */
export function encodeAcpFrame(serializedMessage: string): string {
  return `${serializedMessage}\n`;
}

/**
 * Decoupeur incremental : accumule des chunks d'octets (tels que recus d'un
 * `ReadableStream` ou d'un `ChildProcess.stdout`) et restitue chaque ligne
 * complete des qu'elle est disponible. Necessaire car un message ACP peut
 * arriver fragmente sur plusieurs chunks TCP/pipe, ou plusieurs messages
 * peuvent arriver dans un seul chunk.
 */
export class AcpFrameDecoder {
  #pending: Uint8Array[] = [];
  readonly #decoder = new TextDecoder("utf-8", { fatal: false });

  /** Pousse un nouveau chunk et retourne les lignes completes qu'il permet
   * de former (sans leur `\n` terminal). */
  push(chunk: Uint8Array): string[] {
    const lines: string[] = [];
    let start = 0;
    let newlineIndex = chunk.indexOf(NEWLINE, start);
    while (newlineIndex !== -1) {
      lines.push(this.#takeLine(chunk.subarray(start, newlineIndex)));
      start = newlineIndex + 1;
      newlineIndex = chunk.indexOf(NEWLINE, start);
    }
    if (start < chunk.byteLength) {
      // Copie explicite via le constructeur `Uint8Array` : `chunk` peut etre
      // un `Buffer` Node (sous-classe de Uint8Array) dont `.slice()` est
      // surchargee pour retourner une VUE, pas une copie (piege releve dans
      // le SDK TypeScript officiel, src/line-buffer.ts). Une vue laisserait
      // l'appelant invalider nos octets en attente en reutilisant son
      // buffer source apres ce push.
      this.#pending.push(start === 0 ? chunk : new Uint8Array(chunk.subarray(start)));
    }
    return lines;
  }

  /** Restitue la derniere ligne en cours si le flux se termine sans `\n`
   * final (fermeture propre du subprocess, EOF). Retourne undefined si rien
   * n'est en attente. */
  flush(): string | undefined {
    if (this.#pending.length === 0) {
      return undefined;
    }
    return this.#takeLine(new Uint8Array(0));
  }

  #takeLine(tail: Uint8Array): string {
    let total = tail.byteLength;
    for (const part of this.#pending) {
      total += part.byteLength;
    }
    const line = new Uint8Array(total);
    let offset = 0;
    for (const part of this.#pending) {
      line.set(part, offset);
      offset += part.byteLength;
    }
    line.set(tail, offset);
    this.#pending = [];
    return this.#decoder.decode(line);
  }
}
