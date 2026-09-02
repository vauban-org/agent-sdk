/**
 * Memory write provenance ; Beyond-Hermes W3-T5.
 *
 * Persistent agent memory is a severe attack surface: MINJA (NeurIPS-25, >70%
 * ASR) injects malicious entries through normal interaction ; AgentPoison
 * (arXiv:2407.12784, >80% ASR at <0.1% poison) seeds a poisoned memory/RAG
 * store. A recall layer that trusts whatever is in the store has NO way to tell
 * a genuine entry from an injected one.
 *
 * This binds an Ed25519 PROVENANCE attestation to every memory WRITE: who
 * (agentId + signing key), what (a content hash over the semantic fields), when
 * (recordedAt), and the run/trace it came from. A poisoned recall is then
 * DETECTABLE:
 *   - an entry never written through the provenanced writer has no attestation
 *     ("no-attestation") ;
 *   - an entry whose content was altered after the legitimate write recomputes
 *     to a different hash ("content-tampered") ;
 *   - an entry signed by a key outside the trusted set ("untrusted-signer") ;
 *   - a forged/garbled signature ("bad-signature").
 *
 * This is the SAME attestation substrate as the run-certificate / audit work,
 * applied to the memory tier ; it reuses the SDK Ed25519 signer/verifier. The
 * content hash binds {agentId, runId, event, metadata, traceId} (the semantic
 * payload an attacker would alter) ; the per-row store timestamp is deliberately
 * NOT bound, so a transparent EpisodicMemoryPort decorator can attest a write
 * before delegating to a base port that stamps the time itself.
 *
 * Residual risk (stated honestly): attestation proves ORIGIN + INTEGRITY, not
 * the SEMANTIC TRUTH of a validly-signed-but-wrong memory. A trusted agent that
 * writes a wrong fact produces a valid attestation. Detection of semantic drift
 * is a separate (recall-time) concern.
 *
 * @public @since beyond-hermes-wave3
 * Ref: command-center:beyond-hermes:w3-t5
 */

import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import type {
  EpisodicAppendOptions,
  EpisodicEvent,
  EpisodicMemoryEntry,
  EpisodicMemoryPort,
  EpisodicQueryFilter,
} from "./ports/brain.js";
import type { SignFn, VerifyFn } from "./remote/signing.js";

/**
 * The semantic fields a content hash binds (a subset of EpisodicMemoryEntry).
 * @public
 */
export type MemoryContent = Pick<
  EpisodicMemoryEntry,
  "agentId" | "runId" | "event" | "metadata" | "traceId"
>;

/**
 * Content hash over the semantic fields of a memory entry (SHA-256 over RFC-8785
 * canonical JSON). The store timestamp is excluded by design (see file header).
 * @public
 */
export function memoryEntryContentHash(entry: MemoryContent): string {
  const canon = canonicalize({
    agentId: entry.agentId,
    runId: entry.runId,
    event: entry.event,
    metadata: entry.metadata ?? null,
    traceId: entry.traceId ?? null,
  });
  return createHash("sha256").update(canon, "utf-8").digest("hex");
}

/** @public */
export interface MemoryAttestation {
  agentId: string;
  runId: string;
  traceId?: string;
  event: string;
  /** SHA-256 of the canonical semantic content (see memoryEntryContentHash). */
  contentHash: string;
  /** ISO-8601 time the attestation was produced. */
  recordedAt: string;
  signature: { alg: "Ed25519"; pubkey: string; value: string };
}

/** Exact bytes the Ed25519 signature covers (provenance core). */
function provenanceCore(a: {
  agentId: string;
  runId: string;
  traceId?: string;
  event: string;
  contentHash: string;
  recordedAt: string;
}): string {
  return canonicalize({
    agentId: a.agentId,
    runId: a.runId,
    traceId: a.traceId ?? null,
    event: a.event,
    contentHash: a.contentHash,
    recordedAt: a.recordedAt,
  });
}

/** @public */
export interface AttestMemoryOptions {
  clock?: { now(): number };
}

/**
 * Produce a provenance attestation for a memory write. Pure given the clock +
 * signer. `pubkeyHex` is recorded so a verifier can pin the trusted signer.
 * @public
 */
export function attestMemoryWrite(
  entry: MemoryContent,
  sign: SignFn,
  pubkeyHex: string,
  opts: AttestMemoryOptions = {},
): MemoryAttestation {
  const contentHash = memoryEntryContentHash(entry);
  const recordedAt = new Date(opts.clock ? opts.clock.now() : Date.now()).toISOString();
  const core = provenanceCore({
    agentId: entry.agentId,
    runId: entry.runId,
    ...(entry.traceId !== undefined ? { traceId: entry.traceId } : {}),
    event: entry.event,
    contentHash,
    recordedAt,
  });
  return {
    agentId: entry.agentId,
    runId: entry.runId,
    ...(entry.traceId !== undefined ? { traceId: entry.traceId } : {}),
    event: entry.event,
    contentHash,
    recordedAt,
    signature: { alg: "Ed25519", pubkey: pubkeyHex, value: sign(core) },
  };
}

/** @public */
export type MemoryProvenanceReason =
  | "ok"
  | "no-attestation"
  | "content-tampered"
  | "untrusted-signer"
  | "bad-signature";

/** @public */
export interface MemoryProvenanceResult {
  valid: boolean;
  reason: MemoryProvenanceReason;
}

/**
 * Verify an entry against its attestation. Order: (1) recompute the content hash
 * from the entry and require it to match the attestation (binds entry<->att,
 * catches post-write tampering) ; (2) optional pinned-signer check ;
 * (3) Ed25519 signature over the provenance core.
 * @public
 */
export function verifyMemoryProvenance(
  entry: MemoryContent,
  att: MemoryAttestation,
  verify: VerifyFn,
  opts: { trustedPubkeys?: Iterable<string> } = {},
): MemoryProvenanceResult {
  if (memoryEntryContentHash(entry) !== att.contentHash) {
    return { valid: false, reason: "content-tampered" };
  }
  if (opts.trustedPubkeys) {
    const set = new Set(opts.trustedPubkeys);
    if (!set.has(att.signature.pubkey)) {
      return { valid: false, reason: "untrusted-signer" };
    }
  }
  let ok = false;
  try {
    ok = verify(provenanceCore(att), att.signature.value);
  } catch {
    ok = false;
  }
  return ok ? { valid: true, reason: "ok" } : { valid: false, reason: "bad-signature" };
}

/**
 * Transparent EpisodicMemoryPort decorator that attests every write. Wrap any
 * base port (InMemory, DB-backed) + a signer ; recall is delegated verbatim,
 * and `verifyEntry` checks a recalled entry's provenance ; an entry not written
 * through this writer is "no-attestation" (a poisoning signal).
 *
 * Attestations are held in-process keyed by content hash. A production port
 * persists them alongside the row (migration 037 `trace_id` is the join key) ;
 * this decorator is the SDK mechanism a deployer composes.
 * @public
 */
export class ProvenancedEpisodicMemory implements EpisodicMemoryPort {
  private readonly attestations = new Map<string, MemoryAttestation>();

  constructor(
    private readonly base: EpisodicMemoryPort,
    private readonly sign: SignFn,
    private readonly pubkeyHex: string,
    private readonly clock?: { now(): number },
  ) {}

  async record(
    agentId: string,
    runId: string,
    event: string,
    metadata?: Record<string, unknown>,
    opts?: { traceId?: string },
  ): Promise<void> {
    const content: MemoryContent = {
      agentId,
      runId,
      event,
      ...(metadata !== undefined ? { metadata } : {}),
      ...(opts?.traceId !== undefined ? { traceId: opts.traceId } : {}),
    };
    const att = attestMemoryWrite(
      content,
      this.sign,
      this.pubkeyHex,
      this.clock ? { clock: this.clock } : {},
    );
    this.attestations.set(att.contentHash, att);
    await this.base.record(agentId, runId, event, metadata, opts);
  }

  since(
    agentId: string,
    sinceMs: number,
    opts?: { limit?: number },
  ): Promise<EpisodicMemoryEntry[]> {
    return this.base.since(agentId, sinceMs, opts);
  }

  queryByTrace(traceId: string, opts?: { limit?: number }): Promise<EpisodicMemoryEntry[]> {
    return this.base.queryByTrace(traceId, opts);
  }

  /**
   * Append an episodic event with the same provenance attestation as record()
   * (same semantic fields: agentId/runId(sessionId)/event(eventType)/metadata/traceId
   * feed the content hash ; `content` here plays the `metadata` role for the
   * attestation, matching the record() -> append() delegation on the base port).
   */
  async append(
    agentId: string,
    sessionId: string,
    eventType: string,
    content: string | Record<string, unknown>,
    opts?: EpisodicAppendOptions,
  ): Promise<string> {
    const attestable: MemoryContent = {
      agentId,
      runId: sessionId,
      event: eventType,
      ...(typeof content === "object" ? { metadata: content } : {}),
      ...(opts?.traceId !== undefined ? { traceId: opts.traceId } : {}),
    };
    const att = attestMemoryWrite(
      attestable,
      this.sign,
      this.pubkeyHex,
      this.clock ? { clock: this.clock } : {},
    );
    this.attestations.set(att.contentHash, att);
    return this.base.append(agentId, sessionId, eventType, content, opts);
  }

  query(filter: EpisodicQueryFilter): Promise<EpisodicEvent[]> {
    return this.base.query(filter);
  }

  /** The attestation for an entry's content, or null if never attested here. */
  attestationFor(entry: MemoryContent): MemoryAttestation | null {
    return this.attestations.get(memoryEntryContentHash(entry)) ?? null;
  }

  /**
   * Verify a (recalled) entry's provenance. `no-attestation` means the entry
   * was not written through this provenanced writer ; treat it as untrusted.
   */
  verifyEntry(
    entry: MemoryContent,
    verify: VerifyFn,
    opts: { trustedPubkeys?: Iterable<string> } = {},
  ): MemoryProvenanceResult {
    const att = this.attestationFor(entry);
    if (!att) return { valid: false, reason: "no-attestation" };
    return verifyMemoryProvenance(entry, att, verify, opts);
  }
}
