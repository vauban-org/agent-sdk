/**
 * @vauban-org/agent-sdk/publishers ; per-channel publisher adapters.
 *
 * Backward-compat barrel -- actual files moved to src/adapters/publishers/
 * and src/ports/publisher.ts in 1.16.x. This re-export will be removed in 2.0.
 *
 * PublisherPort defines the uniform shape of a Vauban-ecosystem content
 * publisher. Six concrete publishers ship with the SDK : X, email, Discord,
 * GitHub, Rempart, LinkedIn. New channels register via
 * `createPublisherRegistry({ extras })` without modifying SDK code.
 *
 * @public
 */

export type {
  PublisherPort,
  PublishInput,
  PublishResult,
  PublishStatus,
  PublishContext,
  PublisherChannel,
} from "../ports/publisher.js";

export { XPublisher } from "../adapters/publishers/x.js";
export type {
  XPublisherConfig,
  XPublisherOptions,
} from "../adapters/publishers/x.js";

export { EmailPublisher } from "../adapters/publishers/email.js";
export type { EmailPublisherConfig } from "../adapters/publishers/email.js";

export { DiscordPublisher } from "../adapters/publishers/discord.js";
export type { DiscordPublisherConfig } from "../adapters/publishers/discord.js";

export { GitHubPublisher } from "../adapters/publishers/github.js";
export type { GitHubPublisherConfig } from "../adapters/publishers/github.js";

export { RempartPublisher } from "../adapters/publishers/rempart.js";
export type {
  RempartPublisherConfig,
  RempartMcpCaller,
} from "../adapters/publishers/rempart.js";

export { LinkedInPublisher } from "../adapters/publishers/linkedin.js";
export type {
  LinkedInPublisherConfig,
  LinkedInPublisherOptions,
} from "../adapters/publishers/linkedin.js";

// Registry stays in publishers/ since it is an orchestration concept, not a port or adapter.
export { createPublisherRegistry } from "./registry.js";
export type { PublisherRegistry, PublisherRegistryInput } from "./registry.js";
