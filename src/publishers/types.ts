/**
 * @deprecated Backward-compat shim — actual types moved to src/ports/publisher.ts
 * in 1.16.x. This re-export will be removed in 2.0.
 *
 * @public
 */

export type {
  PublisherChannel,
  PublishStatus,
  PublishContext,
  PublishInput,
  PublishResult,
  PublisherPort,
} from "../ports/publisher.js";
