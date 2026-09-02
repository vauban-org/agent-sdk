/**
 * auth barrel — HMAC-SHA256 event auth helpers (ADR-ECO-017).
 *
 * Exported via "@vauban-org/agent-sdk/auth" subpath so that consumers
 * (e.g. vauban-billing) can import only the auth primitives without
 * pulling in the full SDK index (which includes starknet, BullMQ, etc.).
 *
 * @module auth
 * @public
 */

export { signEvent, canonicalEventString } from "./sign-event.js";
export { verifyEvent } from "./verify-event.js";
export type { VerifyEventOptions } from "./verify-event.js";
export { InMemoryNonceStore, RedisNonceStore } from "./nonce-store.js";
export type { NonceStore, RedisClientLike } from "./nonce-store.js";
export {
  InvalidSignatureError,
  ClockSkewError,
  ReplayDetectedError,
  UnknownSourceError,
  CertChainInvalidError,
  CertExpiredError,
  InstallRevokedError,
} from "./errors.js";
// DomainEvent type — re-exported from ports for consumers that only need the auth subpath.
export type { DomainEvent, EventSource } from "../ports/event-bus.js";
