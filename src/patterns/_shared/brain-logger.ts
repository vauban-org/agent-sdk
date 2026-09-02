/**
 * Shared non-blocking Brain archive helper for orchestration patterns.
 *
 * Returns void (not Promise<void>) — explicit fire-and-forget contract.
 * Callers that accidentally await this get a compile-time warning since
 * void is not meaningfully awaitable.
 *
 * @internal — do not re-export from any public pattern barrel.
 */
import type { BrainEntryInput, BrainPort } from "../../ports/brain.js";

export function logToBrain(brain: BrainPort | undefined | null, entry: BrainEntryInput): void {
  if (!brain) return;
  brain.archiveKnowledge(entry).catch(() => undefined);
}
