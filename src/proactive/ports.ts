/**
 * proactive/ports ; the injected interfaces the engine wires. Pure contracts,
 * zero infra (the preste layer supplies concrete SQLite/Brain/gateway impls).
 * @public @experimental
 */
import type { AttentionVerdict, ProactiveCandidate } from "./types.js";

/**
 * Classifies a candidate into push/digest/silent. Sibling of ActionGate.
 * @public @experimental
 */
export interface AttentionGate {
  classify(candidate: ProactiveCandidate): AttentionVerdict | Promise<AttentionVerdict>;
}

/**
 * A source of candidates. `start` runs until `stop`; it calls `emit` per candidate.
 * @public @experimental
 */
export interface ProactiveTriggerPort {
  readonly source: ProactiveCandidate["source"];
  start(emit: (c: ProactiveCandidate) => void): Promise<void>;
  stop(): Promise<void>;
}

/**
 * One associatively-recalled prior, normalized for the engine.
 * @public @experimental
 */
export interface RecalledPrior {
  readonly id: string;
  readonly content: string;
  /** Activation strength in [0,1]. */
  readonly strength: number;
}

/**
 * Associative recall over durable memory (Brain spreading activation).
 * @public @experimental
 */
export interface AssociativeRecallPort {
  related(subject: string, topK?: number): Promise<RecalledPrior[]>;
}

/**
 * Durable candidate queue (survives a daemon restart).
 * @public @experimental
 */
export interface ProactiveQueuePort {
  enqueue(c: ProactiveCandidate): Promise<void>;
  drainPending(): Promise<ProactiveCandidate[]>;
  markDone(ids: string[]): Promise<void>;
}
