/**
 * Negociation `initialize`, premier echange ACP entre un editeur (le
 * "client" au sens ACP) et un agent de code (preste, ici cote "agent").
 *
 * Formes verifiees directement contre le schema officiel du protocole
 * (agentclientprotocol/agent-client-protocol, schema/v1/schema.json,
 * definitions InitializeRequest / InitializeResponse / ClientCapabilities /
 * AgentCapabilities / Implementation / ProtocolVersion), pas inventees.
 * Voir aussi https://agentclientprotocol.com/protocol/v1/initialization.
 *
 * Portee de cette tranche : uniquement les types + la negociation pure de
 * `initialize`. Le reste du cycle de vie ACP (session/new, session/prompt,
 * session/update, permissions, fs/*, terminal/*...) n'est pas scaffold ici et
 * n'est PAS cable a `AgentLoop` (`packages/agent-sdk/src/loop/`).
 */

/** Version de protocole ACP : entier `uint16`, jamais une chaine semver. La
 * version stable actuelle publiee par l'ecosysteme ACP est 1 (README du
 * depot officiel : "The current stable ACP protocol version is `1`."). */
export type AcpProtocolVersion = number;

/** Seule version que ce scaffold sait negocier. Un futur increment qui
 * cablerait reellement la boucle preste devra elargir cet ensemble au fur et
 * a mesure des versions ACP effectivement supportees, jamais par
 * anticipation. */
const ACP_SUPPORTED_PROTOCOL_VERSIONS: ReadonlySet<AcpProtocolVersion> = new Set([1]);
const ACP_LATEST_SUPPORTED_PROTOCOL_VERSION: AcpProtocolVersion = 1;

/** Metadonnees d'implementation envoyees par le client ou l'agent
 * (`Implementation` dans le schema officiel ; champs `name`+`version`
 * requis, `title` optionnel pour l'affichage humain). */
export interface AcpImplementation {
  readonly name: string;
  readonly title?: string;
  readonly version: string;
}

export interface AcpFileSystemCapabilities {
  readonly readTextFile?: boolean;
  readonly writeTextFile?: boolean;
}

export interface AcpClientCapabilities {
  readonly fs?: AcpFileSystemCapabilities;
  readonly terminal?: boolean;
}

export interface AcpInitializeParams {
  readonly protocolVersion: AcpProtocolVersion;
  readonly clientCapabilities?: AcpClientCapabilities;
  readonly clientInfo?: AcpImplementation;
}

export interface AcpPromptCapabilities {
  readonly image?: boolean;
  readonly audio?: boolean;
  readonly embeddedContext?: boolean;
}

export interface AcpMcpCapabilities {
  readonly http?: boolean;
  readonly sse?: boolean;
}

export interface AcpAgentCapabilities {
  readonly loadSession?: boolean;
  readonly promptCapabilities?: AcpPromptCapabilities;
  readonly mcpCapabilities?: AcpMcpCapabilities;
}

/** `authMethods` peut porter des descripteurs de methode d'authentification
 * OAuth-like ; hors scope de cette tranche (aucune methode annoncee). Type
 * laisse ouvert plutot que de fabriquer une forme non verifiee. */
export type AcpAuthMethod = Readonly<Record<string, unknown>>;

export interface AcpInitializeResult {
  readonly protocolVersion: AcpProtocolVersion;
  readonly agentCapabilities: AcpAgentCapabilities;
  readonly authMethods: readonly AcpAuthMethod[];
  readonly agentInfo: AcpImplementation;
}

/**
 * Negocie la version de protocole selon la regle du schema officiel :
 * "The protocol version the client specified if supported by the agent, or
 * the latest protocol version supported by the agent." On echoue donc le
 * choix du client s'il est dans l'ensemble supporte, sinon on retombe sur la
 * derniere version supportee, jamais l'inverse (ne jamais promettre une
 * version qu'on ne sait pas parler). C'est la responsabilite du CLIENT de se
 * deconnecter si la version renvoyee ne lui convient pas (meme source).
 */
export function negotiateAcpProtocolVersion(requested: AcpProtocolVersion): AcpProtocolVersion {
  return ACP_SUPPORTED_PROTOCOL_VERSIONS.has(requested)
    ? requested
    : ACP_LATEST_SUPPORTED_PROTOCOL_VERSION;
}

/**
 * Construit la reponse `initialize` de preste-en-tant-qu'agent-ACP.
 *
 * Honnetete deliberee : toutes les capacites optionnelles sont declarees a
 * `false` / vides. Rien n'est cable a `AgentLoop` dans cette tranche (pas de
 * session, pas de chargement de session, pas de MCP relaye, pas
 * d'image/audio/contexte embarque) ; les annoncer autrement serait une
 * garantie de conformite ACP non verifiee. Un futur increment qui cable
 * reellement une capacite devra faire passer son flag a `true` au meme
 * commit que le cablage, jamais avant.
 */
export function negotiateAcpInitialize(
  params: AcpInitializeParams,
  agentInfo: AcpImplementation,
): AcpInitializeResult {
  return {
    protocolVersion: negotiateAcpProtocolVersion(params.protocolVersion),
    agentCapabilities: {
      loadSession: false,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      mcpCapabilities: { http: false, sse: false },
    },
    authMethods: [],
    agentInfo,
  };
}
