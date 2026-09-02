// Point d'entree du scaffold ACP (Agent Client Protocol). Voir
// packages/agent-sdk/src/acp/jsonrpc.ts pour le contexte et les sources
// verifiees de la spec ; premiere tranche = enveloppe JSON-RPC + framing
// ndjson + negociation `initialize`, non cable a AgentLoop.

export type {
  AcpMessageId,
  AcpRequest,
  AcpNotification,
  AcpErrorObject,
  AcpSuccessResponse,
  AcpErrorResponse,
  AcpResponse,
  AcpMessage,
} from "./jsonrpc.js";
export { AcpProtocolError, parseAcpMessage, serializeAcpMessage } from "./jsonrpc.js";

export { encodeAcpFrame, AcpFrameDecoder } from "./framing.js";

export type {
  AcpProtocolVersion,
  AcpImplementation,
  AcpFileSystemCapabilities,
  AcpClientCapabilities,
  AcpInitializeParams,
  AcpPromptCapabilities,
  AcpMcpCapabilities,
  AcpAgentCapabilities,
  AcpAuthMethod,
  AcpInitializeResult,
} from "./initialize.js";
export { negotiateAcpProtocolVersion, negotiateAcpInitialize } from "./initialize.js";

export type { AcpStdioAgentServerOptions } from "./stdio-server.js";
export { AcpStdioAgentServer } from "./stdio-server.js";

export type { RunAcpStdioServerOptions } from "./run-stdio.js";
export { runAcpStdioServer } from "./run-stdio.js";
