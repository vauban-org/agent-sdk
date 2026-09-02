/**
 * remote — SDK remote-control: observe and steer a running agent from a
 * remote client (a phone app, a browser, another terminal).
 *
 * Outbound: a signed `SessionEvent` stream (AG-UI-aligned).
 * Inbound:  an `InstructionInbox` (mid-run steering) + a `RemoteApprovalChannel`
 *           (HITL from the remote).
 *
 * The `RemoteControlHub` is the central port; `createRemoteControlServer` is
 * the reference HTTP/SSE transport. Any SDK consumer wires the hub's sink +
 * inbox into its `AgentLoop` to become remotely controllable.
 *
 * @public @since 2.11.0 — preste remote-control T1
 */

export {
  SessionEventSchema,
  ControlAckPayloadSchema,
  PodStartedPayloadSchema,
  PodStartedFleetCertSchema,
  type PodStartedFleetCert,
  CertRenewedPayloadSchema,
  type CertRenewedPayload,
  FleetSigningKeyCertSchema,
  type FleetSigningKeyCert,
  POD_START_STAGES,
  PodStartProgressPayloadSchema,
  type PodStartProgressStage,
  type PodStartProgressPayload,
  TeamActionRosterRowSchema,
  TeamActionLiveSessionSchema,
  TeamActionResultPayloadSchema,
  RemoteGrantPayloadSchema,
  type RemoteGrantPayload,
  AutoVerdictPayloadSchema,
  type AutoVerdictPayload,
  makeEvent,
  looksLikeSessionEvent,
  __resetEventSeq,
  type SessionEvent,
  type SessionEventType,
} from "./events.js";

export {
  ALL_KNOWN_EVENT_TYPES,
  isKnownEventType,
  toCanonicalEventType,
} from "./event-name-map.js";

export { NOOP_SESSION_SINK, teeSink, type SessionEventSink } from "./sink.js";

export {
  InMemoryInstructionInbox,
  type Instruction,
  type InstructionInbox,
} from "./inbox.js";

// SP-C.1 — the session-origin seam: a phone can START a session, not only
// attach to one a human started. Types only; every implementation lives with
// its substrate (the CLI's local origin; the pod's at SP-C.2).
export {
  ALL_SESSION_ORIGIN_KINDS,
  isSessionOriginKind,
  SessionOriginError,
  type AttachedSession,
  type SessionOrigin,
  type SessionOriginKind,
  type SessionRef,
  type SessionStartGrant,
  type SessionStartRequest,
  type SessionStartWork,
  type StartedSession,
} from "./session-origin.js";

export {
  ALL_LINK_STATUSES,
  createRemoteControlHub,
  isLinkStatus,
  loadHubFromPersistence,
  type LinkStatus,
  type RemoteControlPort,
  type RemoteControlHubOptions,
  type SessionState,
  type SessionStatus,
} from "./port.js";

// P7 — durable backing store for revocations + events (gates Bastion verifier).
export {
  InMemoryPersistencePort,
  tryPersistEvent,
  type PersistencePort,
} from "./persistence.js";

// P7 — SQLite-backed default impl (closes R2 token-replay-after-restart).
// `better-sqlite3` is an OPTIONAL peerDep ; consumers that need durable
// persistence install it themselves. The class is loadable in environments
// where the dep is absent — only the constructor throws.
export {
  SqlitePersistencePort,
  sqlitePathForSession,
  type SqlitePersistenceOptions,
} from "./persistence-sqlite.js";

export {
  createRemoteApprovalChannel,
  type RemoteApprovalChannel,
  type RemoteApprovalOptions,
  type RemoteTimeoutPolicy,
  type RemoteHitlRecord,
} from "./approval.js";

export {
  createRemoteControlServer,
  type RemoteControlServerOptions,
  type RemoteControlServerHandle,
  type TeammateSendOutcome,
  type TeammateSendPort,
  type TeammateTargetInfo,
  type TeammateInfoPort,
  type TeammateInfoPeer,
  type TeammateInfoSession,
  type TeammateInfoSnapshot,
  type TeammateEventPushOutcome,
  type TeammateEventSinkPort,
} from "./http-server.js";

// T2 — sovereign relay: E2E crypto, protocol, PC-side client.
export {
  generateSessionKeyPair,
  importPublicKey,
  importPrivateKey,
  deriveSharedKey,
  seal,
  open,
  type SessionKeyPair,
} from "./crypto.js";

export {
  RELAY_PROTOCOL_VERSION,
  encodePairingPayload,
  decodePairingPayload,
  relayPaths,
  type PairingPayload,
  type RelayFrame,
  type RelayMessage,
} from "./relay-protocol.js";

export {
  connectRelay,
  type ConnectRelayOptions,
  type RelayConnection,
} from "./relay-client.js";

// T6h — durable outgoing queue for relay sends.
export {
  OutgoingMessageStore,
  outgoingStorePath,
  MAX_OUTGOING_ATTEMPTS,
  type OutgoingMessageRow,
  type OutgoingMessageStoreOptions,
} from "./outgoing-store.js";

// T3 — Ed25519-signed event stream (tamper-evident audit trail).
export {
  canonicalEventString,
  signEvent,
  verifyEvent,
  createEd25519Signer,
  createEd25519Verifier,
  type SignFn,
  type VerifyFn,
} from "./signing.js";

// T6a — pre-tool-call veto window.
export {
  InMemoryVetoChannel,
  type VetoChannel,
  type VetoSignal,
} from "./veto.js";

// T6e — attested proof export (shareable signed claim of a run).
// P10 — settlement receipt embedding (zkpay Sepolia POC).
export {
  PROOF_CLAIM_VERSION,
  canonicalClaimString,
  exportProofClaim,
  sha256Hex,
  verifyProofClaim,
  withPaymentReceipt,
  type ExportProofClaimOptions,
  type PaymentAuthorization,
  type ProofClaim,
  type ProofClaimVerification,
  type ProofReceipt,
  type SettlementReceipt,
} from "./proof-export.js";

// T6f — capability-scoped sub-tokens (HMAC-attenuated handoff).
// P1b-2 — `rebindSubToken` upgrades a bearer sub-token to device-bound.
export {
  mintSubToken,
  rebindSubToken,
  resolveAuthScope,
  scopeCovers,
  verifySubToken,
  type MintSubTokenOptions,
  type RebindSubTokenOptions,
  type RebindSubTokenResult,
  type SubTokenClaims,
  type SubTokenScope,
  type VerifySubTokenResult,
} from "./sub-token.js";

// P11 — sub-token OTEL instrumentation (opt-in observability layer).
export {
  classifyReason,
  hashJti,
  mintSubTokenInstrumented,
  recordRevocation,
  resolveAuthScopeInstrumented,
  verifySubTokenInstrumented,
} from "./sub-token-otel.js";

// P1b — DPoP device-binding primitives (RFC 9449 + RFC 7800 cnf claim).
export {
  computeJwkThumbprint,
  DpopReplayStore,
  validateDpopProof,
  type DpopClaims,
  type DpopValidationFailure,
  type DpopValidationResult,
  type EcP256Jwk,
  type ValidateDpopOptions,
  type ValidatedDpop,
} from "./dpop.js";

// T4 — multi-platform gateway: one agent session, many surfaces.
export {
  createGateway,
  renderEventForChat,
  truncate,
  createTelegramAdapter,
  createDiscordAdapter,
  createSlackAdapter,
  defaultWebSocketFactory,
  NOOP_LOGGER,
  type GatewayOptions,
  type GatewayHandle,
  type GatewayAdapter,
  type GatewayLogger,
  type InboundMessage,
  type ApprovalPrompt,
  type ApprovalCallback,
  type RenderOptions,
  type WebSocketLike,
  type WebSocketFactory,
  type TelegramAdapterOptions,
  type DiscordAdapterOptions,
  type SlackAdapterOptions,
} from "./gateway/index.js";
