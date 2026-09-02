/**
 * conversation — tiered memory for multi-turn agent sessions.
 * @public @since 2.3.0
 */

export type {
  Turn,
  CompactionSummary,
  CompactionReport,
  ConversationContextSnapshot,
  LLMMessage,
  ConversationContextOpts,
} from "./types.js";

export { ConversationContext } from "./context.js";
export type { CompactionLLMFn, CompactOpts } from "./context.js";
export {
  createBrainCompactionLlmFn,
  restoreSessionContext,
} from "./brain-connector.js";
