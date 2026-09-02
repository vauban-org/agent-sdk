/**
 * Schema validation for RecallOptions, RecallResult, and RecallChunk.
 *
 * Promoted from apps/agents/forecaster/src/recall/schema.ts to SDK port
 * per ADR-ECO-065 (sprint-805 Stage 2).
 *
 * Pure TypeScript type-guard implementation — no Zod dependency.
 * All validators are .strict()-equivalent: unknown keys are rejected.
 *
 * Note on naming: the L1 prototype used `BrainChunk` for the HTTP DTO type.
 * In the SDK port it is renamed `RecallChunk` to avoid collision with the
 * SDK's domain-level `BrainChunk` (orchestration/ooda/brain-context.ts).
 * The validator function is named `parseRecallChunk` accordingly.
 *
 * @public
 */

import type { FreshnessMarker, RecallChunk, RecallOptions, RecallResult } from "./types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Known keys for RecallOptions — used to enforce .strict() semantics. */
const RECALL_OPTIONS_KEYS = new Set<string>([
  "tier",
  "topK",
  "minSimilarity",
  "brainIds",
  "tags",
  "mode",
]);

/** Known keys for RecallResult — used to enforce .strict() semantics. */
const RECALL_RESULT_KEYS = new Set<string>([
  "chunks",
  "answer",
  "strategy_used",
  "hops_used",
  "refs",
  "freshness",
]);

/** Known keys for RecallChunk — used to enforce .strict() semantics. */
const RECALL_CHUNK_KEYS = new Set<string>([
  "id",
  "content",
  "hybrid_score",
  "cross_encoder_score",
  "similarity",
  "category",
  "tags",
  "created_at",
  "brain_id",
  "brain_slug",
]);

/** Known keys for FreshnessMarker — used to enforce .strict() semantics. */
const FRESHNESS_MARKER_KEYS = new Set<string>(["entryId", "validFrom", "validUntil", "stale"]);

function hasNoUnknownKeys(obj: object, allowed: Set<string>): boolean {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) return false;
  }
  return true;
}

function isStringOrUndefined(v: unknown): v is string | undefined {
  return v === undefined || typeof v === "string";
}

function isNumberOrNull(v: unknown): v is number | null {
  return v === null || typeof v === "number";
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

// ─── RecallOptions validation ─────────────────────────────────────────────────

/**
 * Validate a RecallOptions object.
 * Returns the typed value or throws a TypeError describing the first violation.
 * Strict: rejects unknown keys.
 * @public
 */
export function parseRecallOptions(value: unknown): RecallOptions {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("RecallOptions must be a non-null object");
  }
  const obj = value as Record<string, unknown>;

  if (!hasNoUnknownKeys(obj, RECALL_OPTIONS_KEYS)) {
    const unknown = Object.keys(obj).filter((k) => !RECALL_OPTIONS_KEYS.has(k));
    throw new TypeError(`RecallOptions: unknown keys [${unknown.join(", ")}]`);
  }

  const mode = obj.mode;
  if (mode !== "chunks" && mode !== "answer") {
    throw new TypeError(
      `RecallOptions.mode must be "chunks" or "answer", got ${JSON.stringify(mode)}`,
    );
  }

  const tier = obj.tier;
  if (tier !== undefined && tier !== "auto" && tier !== "fast" && tier !== "agentic") {
    throw new TypeError(
      `RecallOptions.tier must be "auto", "fast", or "agentic", got ${JSON.stringify(tier)}`,
    );
  }

  const topK = obj.topK;
  if (topK !== undefined && (typeof topK !== "number" || topK < 1 || topK > 20)) {
    throw new TypeError(
      `RecallOptions.topK must be a number in [1..20], got ${JSON.stringify(topK)}`,
    );
  }

  const minSimilarity = obj.minSimilarity;
  if (
    minSimilarity !== undefined &&
    (typeof minSimilarity !== "number" || minSimilarity < 0 || minSimilarity > 1)
  ) {
    throw new TypeError(
      `RecallOptions.minSimilarity must be a number in [0..1], got ${JSON.stringify(
        minSimilarity,
      )}`,
    );
  }

  const brainIds = obj.brainIds;
  if (brainIds !== undefined) {
    if (!Array.isArray(brainIds) || !brainIds.every((v) => typeof v === "string")) {
      throw new TypeError("RecallOptions.brainIds must be string[] or undefined");
    }
  }

  const tags = obj.tags;
  if (tags !== undefined) {
    if (!Array.isArray(tags) || !tags.every((v) => typeof v === "string")) {
      throw new TypeError("RecallOptions.tags must be string[] or undefined");
    }
  }

  return obj as unknown as RecallOptions;
}

// ─── RecallChunk validation ───────────────────────────────────────────────────

/**
 * Validate a single RecallChunk object.
 * Strict: rejects unknown keys.
 *
 * Formerly named `parseBrainChunk` in the L1 prototype (forecaster).
 * Renamed to `parseRecallChunk` in the SDK port to avoid collision with
 * the SDK's domain BrainChunk type (orchestration/ooda/brain-context.ts).
 * @public
 */
export function parseRecallChunk(value: unknown): RecallChunk {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("RecallChunk must be a non-null object");
  }
  const obj = value as Record<string, unknown>;

  if (!hasNoUnknownKeys(obj, RECALL_CHUNK_KEYS)) {
    const unknown = Object.keys(obj).filter((k) => !RECALL_CHUNK_KEYS.has(k));
    throw new TypeError(`RecallChunk: unknown keys [${unknown.join(", ")}]`);
  }

  if (typeof obj.id !== "string") {
    throw new TypeError("RecallChunk.id must be a string");
  }
  if (typeof obj.content !== "string") {
    throw new TypeError("RecallChunk.content must be a string");
  }
  if (!isNumberOrNull(obj.hybrid_score)) {
    throw new TypeError("RecallChunk.hybrid_score must be number | null");
  }
  if (!isNumberOrNull(obj.cross_encoder_score)) {
    throw new TypeError("RecallChunk.cross_encoder_score must be number | null");
  }
  if (!isNumberOrNull(obj.similarity)) {
    throw new TypeError("RecallChunk.similarity must be number | null");
  }
  if (typeof obj.category !== "string") {
    throw new TypeError("RecallChunk.category must be a string");
  }
  if (!Array.isArray(obj.tags) || !(obj.tags as unknown[]).every((v) => typeof v === "string")) {
    throw new TypeError("RecallChunk.tags must be string[]");
  }
  if (typeof obj.created_at !== "string") {
    throw new TypeError("RecallChunk.created_at must be a string");
  }
  if (!isStringOrNull(obj.brain_id)) {
    throw new TypeError("RecallChunk.brain_id must be string | null");
  }
  if (!isStringOrNull(obj.brain_slug)) {
    throw new TypeError("RecallChunk.brain_slug must be string | null");
  }

  return obj as unknown as RecallChunk;
}

/**
 * @deprecated Use `parseRecallChunk` instead. Alias preserved for backward
 * compatibility with any code referencing the L1 prototype's name.
 * @public
 */
export const parseBrainChunk = parseRecallChunk;

// ─── FreshnessMarker validation ───────────────────────────────────────────────

/**
 * Validate a FreshnessMarker object.
 * Strict: rejects unknown keys.
 * @public
 */
export function parseFreshnessMarker(value: unknown): FreshnessMarker {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("FreshnessMarker must be a non-null object");
  }
  const obj = value as Record<string, unknown>;

  if (!hasNoUnknownKeys(obj, FRESHNESS_MARKER_KEYS)) {
    const unknown = Object.keys(obj).filter((k) => !FRESHNESS_MARKER_KEYS.has(k));
    throw new TypeError(`FreshnessMarker: unknown keys [${unknown.join(", ")}]`);
  }

  if (typeof obj.entryId !== "string") {
    throw new TypeError("FreshnessMarker.entryId must be a string");
  }
  if (!isStringOrUndefined(obj.validFrom)) {
    throw new TypeError("FreshnessMarker.validFrom must be string or undefined");
  }
  if (!isStringOrUndefined(obj.validUntil)) {
    throw new TypeError("FreshnessMarker.validUntil must be string or undefined");
  }
  if (typeof obj.stale !== "boolean") {
    throw new TypeError("FreshnessMarker.stale must be a boolean");
  }

  return obj as unknown as FreshnessMarker;
}

// ─── RecallResult validation ──────────────────────────────────────────────────

/**
 * Validate a RecallResult object.
 * Strict: rejects unknown keys.
 * @public
 */
export function parseRecallResult(value: unknown): RecallResult {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("RecallResult must be a non-null object");
  }
  const obj = value as Record<string, unknown>;

  if (!hasNoUnknownKeys(obj, RECALL_RESULT_KEYS)) {
    const unknown = Object.keys(obj).filter((k) => !RECALL_RESULT_KEYS.has(k));
    throw new TypeError(`RecallResult: unknown keys [${unknown.join(", ")}]`);
  }

  if (!Array.isArray(obj.chunks)) {
    throw new TypeError("RecallResult.chunks must be an array");
  }
  for (const c of obj.chunks as unknown[]) {
    parseRecallChunk(c);
  }

  if (!isStringOrNull(obj.answer)) {
    throw new TypeError("RecallResult.answer must be string | null");
  }
  if (typeof obj.strategy_used !== "string") {
    throw new TypeError("RecallResult.strategy_used must be a string");
  }
  if (typeof obj.hops_used !== "number") {
    throw new TypeError("RecallResult.hops_used must be a number");
  }
  if (!Array.isArray(obj.refs) || !(obj.refs as unknown[]).every((v) => typeof v === "string")) {
    throw new TypeError("RecallResult.refs must be string[]");
  }
  if (!Array.isArray(obj.freshness)) {
    throw new TypeError("RecallResult.freshness must be an array");
  }
  for (const f of obj.freshness as unknown[]) {
    parseFreshnessMarker(f);
  }

  return obj as unknown as RecallResult;
}
