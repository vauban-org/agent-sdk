/**
 * Enveloppe JSON-RPC 2.0 du Agent Client Protocol (ACP).
 *
 * Pourquoi ce fichier existe : ACP n'invente pas son propre format de
 * message, il reutilise JSON-RPC 2.0 tel quel pour les requetes, notifications
 * et reponses echangees entre un editeur (Zed, JetBrains...) et un agent de
 * code. Verifie contre le schema officiel du protocole
 * (agentclientprotocol/agent-client-protocol, schema/v1/schema.json,
 * definitions AnyRequest/AnyResponse/AnyNotification) et contre le SDK
 * TypeScript officiel (@agentclientprotocol/sdk, src/jsonrpc.ts). On type
 * donc ici le sous-ensemble JSON-RPC 2.0 qu'ACP utilise sur le fil, sans
 * reinventer un protocole maison.
 *
 * Ce module ne fait QUE le parsing/validation de l'enveloppe generique. La
 * negociation `initialize` (methode ACP specifique) vit dans `initialize.ts`.
 */

/** Identifiant de correlation requete/reponse JSON-RPC. ACP utilise des ids
 * numeriques dans ses propres exemples mais la RFC autorise aussi la chaine ;
 * on garde les deux pour ne pas refuser un client conforme. */
export type AcpMessageId = string | number;

export interface AcpRequest<TParams = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: AcpMessageId;
  readonly method: string;
  readonly params?: TParams;
}

export interface AcpNotification<TParams = unknown> {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: TParams;
}

export interface AcpErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface AcpSuccessResponse<TResult = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: AcpMessageId | null;
  readonly result: TResult;
}

export interface AcpErrorResponse {
  readonly jsonrpc: "2.0";
  readonly id: AcpMessageId | null;
  readonly error: AcpErrorObject;
}

export type AcpResponse<TResult = unknown> = AcpSuccessResponse<TResult> | AcpErrorResponse;

export type AcpMessage = AcpRequest | AcpNotification | AcpResponse;

/**
 * Erreur de frontiere : toute donnee lue depuis un subprocess ACP (donc
 * potentiellement un editeur tiers non fiable) qui ne respecte pas
 * l'enveloppe JSON-RPC 2.0 attendue leve cette erreur plutot que de
 * silencieusement produire un objet partiel. Zero Trust : on valide a la
 * frontiere, on ne suppose jamais une forme correcte.
 */
export class AcpProtocolError extends Error {
  constructor(
    message: string,
    readonly raw: unknown,
  ) {
    super(message);
    this.name = "AcpProtocolError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessageId(value: unknown): value is AcpMessageId {
  return typeof value === "string" || typeof value === "number";
}

/**
 * Parse une ligne JSON brute (deja isolee par le framing ndjson, voir
 * `framing.ts`) en message ACP type. Distingue requete / notification /
 * reponse par la forme presente (id+method = requete, method seul =
 * notification, id+result ou id+error = reponse), en miroir de la logique de
 * classification du SDK TypeScript officiel (`AnyMessage` union).
 */
export function parseAcpMessage(raw: string): AcpMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new AcpProtocolError(
      `ligne non-JSON recue sur le canal ACP : ${(cause as Error).message}`,
      raw,
    );
  }

  if (!isPlainObject(parsed)) {
    throw new AcpProtocolError("message ACP attendu comme objet JSON", parsed);
  }

  if (parsed.jsonrpc !== "2.0") {
    throw new AcpProtocolError('champ "jsonrpc" absent ou different de "2.0"', parsed);
  }

  const hasId = "id" in parsed;
  const hasMethod = "method" in parsed;
  const hasResult = "result" in parsed;
  const hasError = "error" in parsed;

  if (hasMethod) {
    if (typeof parsed.method !== "string" || parsed.method.length === 0) {
      throw new AcpProtocolError('champ "method" doit etre une chaine non vide', parsed);
    }
    if (hasId) {
      if (!isMessageId(parsed.id)) {
        throw new AcpProtocolError('champ "id" doit etre une chaine ou un nombre', parsed);
      }
      return {
        jsonrpc: "2.0",
        id: parsed.id,
        method: parsed.method,
        ...("params" in parsed ? { params: parsed.params } : {}),
      } as AcpRequest;
    }
    return {
      jsonrpc: "2.0",
      method: parsed.method,
      ...("params" in parsed ? { params: parsed.params } : {}),
    } as AcpNotification;
  }

  if (hasResult || hasError) {
    if (hasResult && hasError) {
      throw new AcpProtocolError(
        'une reponse JSON-RPC ne peut pas porter "result" ET "error"',
        parsed,
      );
    }
    if (!("id" in parsed) || (parsed.id !== null && !isMessageId(parsed.id))) {
      throw new AcpProtocolError(
        'reponse ACP : champ "id" doit etre une chaine, un nombre ou null',
        parsed,
      );
    }
    if (hasError) {
      const err = parsed.error;
      if (!isPlainObject(err) || typeof err.code !== "number" || typeof err.message !== "string") {
        throw new AcpProtocolError(
          'champ "error" doit contenir au moins { code: number, message: string }',
          parsed,
        );
      }
      return {
        jsonrpc: "2.0",
        id: parsed.id as AcpMessageId | null,
        error: {
          code: err.code,
          message: err.message,
          ...("data" in err ? { data: err.data } : {}),
        },
      };
    }
    return {
      jsonrpc: "2.0",
      id: parsed.id as AcpMessageId | null,
      result: parsed.result,
    };
  }

  throw new AcpProtocolError(
    'message ACP non reconnu : ni "method" (requete/notification) ni "result"/"error" (reponse)',
    parsed,
  );
}

/** Serialise un message ACP en JSON compact, pret a etre encadre par
 * `encodeAcpFrame` (framing.ts). Separee du framing pour rester testable
 * independamment du transport. */
export function serializeAcpMessage(message: AcpMessage): string {
  return JSON.stringify(message);
}
