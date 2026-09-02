/**
 * Privacy module — agentic privacy primitives via HDNT.
 *
 * Implements the first slice of the Vauban Privacy Protocol integration
 * (sprint-576:agentic-privacy-impl):
 *   A. Agent nullifier hierarchy (HDNT §2 derivation paths)
 *   B. Delegation-as-Claim skeleton
 *
 * Design references:
 *   - vauban-privacy-protocol/docs/research/03-agentic-privacy.md
 *   - vauban-privacy-protocol/docs/research/05-cross-domain-nullifiers.md
 *
 * @module privacy
 */

export { deriveAgentNullifier, deriveActionNullifier } from "./nullifier.js";
export { poseidonHashBigInt, labelToFelt, feltMod } from "./poseidon-felt252.js";
export {
  buildDelegationClaim,
  serializeDelegationScope,
  isDelegationScopeValid,
  isActionAllowed,
} from "./delegation.js";
export type {
  DelegationScope,
  DelegationClaim,
  ClaimRef,
} from "./delegation.js";
export {
  establishChannel,
  sendOverChannel,
  receiveOverChannel,
  computeAuthTag,
  ChannelError,
} from "./channel.js";
export type {
  AgentChannel,
  EncryptedAgentMessage,
  ChannelErrorKind,
} from "./channel.js";
export {
  composeAgents,
  buildAgentClaimWithDelegation,
  CompositionError,
} from "./composition.js";
export type {
  AgentClaim,
  ShieldedClaim,
  CompositionMode,
} from "./composition.js";
export {
  contributeAnchorToUAR,
  mockSubmitToUAR,
  isLeafFresh,
  contributeMultipleAnchors,
  UAR_DOMAIN_TAG_AGENTIC,
  UAR_DOMAIN_TAG_STARKNET,
  UAR_DOMAIN_TAG_W3C_VC,
  UAR_DOMAIN_TAG_MDOC,
} from "./uar.js";
export type {
  UARLeaf,
  UARAggregatorReceipt,
} from "./uar.js";
