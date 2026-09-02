/**
 * run-memory : window-as-cache-over-durable-store for agent loops (L1).
 * Spec: docs/superpowers/specs/2026-07-08-grounded-loop-design.md.
 * @public @experimental
 */
export { CompositeRunJournal } from "./composite-run-journal.js";
export {
  type CompactionOutcome,
  type Compactor,
  type CompactorConfig,
  createCompactor,
} from "./compactor.js";
export { FileRunJournal } from "./file-run-journal.js";
export { createRecallTool } from "./recall-tool.js";
export type { JournalAppendMeta, JournalStep, RunJournalPort } from "./types.js";
