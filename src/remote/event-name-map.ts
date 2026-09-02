/**
 * remote/event-name-map — canonical AG-UI event type helpers (3.0.0+).
 *
 * Since 3.0.0, the Vauban SDK emits **only** AG-UI canonical UPPER_SNAKE_CASE
 * event types (`RUN_STARTED`, `TEXT_MESSAGE_CONTENT`, `TOOL_CALL_START`, etc.).
 * The legacy dotted-lowercase vocabulary (`run.start`, `assistant.delta`, …)
 * emitted before 2.28.0 is fully dropped ; consumers that still produce legacy
 * types at the emit boundary pass through `toCanonicalEventType` automatically.
 *
 * Vauban-specific extensions with no direct AG-UI peer are projected onto the
 * `CUSTOM_*` prefix so the conformance suite's closed-vocabulary check passes :
 *   `tool.intent`          → `CUSTOM_TOOL_INTENT`
 *   `hitl.request`         → `CUSTOM_HITL_REQUEST`
 *   `hitl.resolved`        → `CUSTOM_HITL_RESOLVED`
 *   `instruction.injected` → `CUSTOM_INSTRUCTION_INJECTED`
 *
 * @public @since 2.27.0 (3.0.0 — legacy mapping removed)
 */

// ─── Internal dotted → canonical map (not exported to avoid CI gate) ─────────

const DOTTED_TO_CANONICAL: Record<string, string> = {
  // ─── Lifecycle ──────────────────────────────────────────────────────────────
  "run.start": "RUN_STARTED",
  "run.step": "STEP_STARTED",
  "run.finished": "RUN_FINISHED",

  // ─── Text messages ──────────────────────────────────────────────────────────
  "assistant.delta": "TEXT_MESSAGE_CONTENT",
  "assistant.message": "TEXT_MESSAGE_END",

  // ─── Tool calls ─────────────────────────────────────────────────────────────
  "tool.call.start": "TOOL_CALL_START",
  "tool.call.end": "TOOL_CALL_END",

  // ─── State ──────────────────────────────────────────────────────────────────
  state: "STATE_SNAPSHOT",

  // ─── Vauban extensions (projected onto AG-UI CUSTOM_* closed vocab) ─────────
  "tool.intent": "CUSTOM_TOOL_INTENT",
  "hitl.request": "CUSTOM_HITL_REQUEST",
  "hitl.resolved": "CUSTOM_HITL_RESOLVED",
  "instruction.injected": "CUSTOM_INSTRUCTION_INJECTED",
};

/** Reverse map — canonical → dotted (used only for ALL_KNOWN_EVENT_TYPES). */
const CANONICAL_TO_DOTTED: Record<string, string> = Object.fromEntries(
  Object.entries(DOTTED_TO_CANONICAL).map(([d, c]) => [c, d]),
);

/**
 * Canonical types introduced AFTER the 3.0.0 legacy-shim freeze: they never
 * had a pre-3.0.0 dotted-lowercase form to bridge from, so they have no entry
 * in `DOTTED_TO_CANONICAL` above (adding a fake dotted partner would misstate
 * history). Listed separately and unioned into `ALL_KNOWN_EVENT_TYPES` below
 * so the guard still recognises them.
 */
const CANONICAL_ONLY_TYPES: readonly string[] = [
  // sprint-893 d1 (ZD4) ; teammate-origin delivery, additive alongside
  // CUSTOM_INSTRUCTION_INJECTED, never a replacement for it.
  "CUSTOM_TEAMMATE_DELIVERY",
  // Relayed Control W2 (ADR-ECO-118/119) ; the host's anti-oracle verdict for
  // a relayed steer, correlated to the steer by a client `steerId`. No
  // pre-3.0.0 dotted form ever existed for it.
  "CUSTOM_CONTROL_ACK",
  // A' pod roster auto-discovery ; the host emits a pod's PUBLIC fleet install
  // cert on the observe leg so a starter's PWA auto-merges it into its roster.
  // Rides the fleet-CEK-encrypted stream ; never the control ACK (anti-oracle).
  "CUSTOM_POD_STARTED",
  // Finding #5b fleet-cert renewal delivery ; the host emits a member's renewed
  // PUBLIC fleet install cert on the observe leg so a browser member folds the
  // extended validity window in with zero re-key ceremony. Sibling of A' ; same
  // observe-leg-only, same anti-oracle discipline. No pre-3.0.0 dotted form.
  "CUSTOM_FLEET_CERT_RENEWED",
  // V2-C mission-control progress rail ; the pod origin emits a named-state beat
  // on the observe leg at each governance-pipeline boundary of a pod start, so a
  // phone renders a live timeline. Observe-leg-only ; anti-oracle (a failed beat
  // carries a structural reason, never external_data). No pre-3.0.0 dotted form.
  "CUSTOM_POD_START_PROGRESS",
  // sprint-1067 T3 team-actions-v2 ; the host's structural result for one team
  // action (team-list roster / team-send delivered-resolved-no-route / delegate
  // -coordinate-start executed), so a relayed or executed team action is never
  // silently dropped. Observe-leg-only ; the control ACK never carries it
  // (anti-oracle). No pre-3.0.0 dotted form.
  "CUSTOM_TEAM_ACTION_RESULT",
  // sprint-1067 T3 remote-grant-scopes ; a standing grant minted from a REMOTE
  // approval, announced on the observe leg so a grant never appears in the
  // session's memory without a visible trace of who created it. Observe-leg-only ;
  // the control ACK never carries it (anti-oracle). No pre-3.0.0 dotted form.
  "CUSTOM_REMOTE_GRANT",
  // sprint-1067 t3 auto-approve-visibility ; a verdict reached WITHOUT asking
  // anyone (a matched standing grant, or a retry coalesced onto a recent
  // verdict), announced so an action never lands with no card and no
  // explanation. Observe-leg-only ; the control ACK never carries it
  // (anti-oracle). No pre-3.0.0 dotted form.
  "CUSTOM_AUTO_VERDICT",
];

// ─── Public surface ───────────────────────────────────────────────────────────

/**
 * Every event type name (dotted-lowercase shim OR canonical UPPER_SNAKE) that
 * the SDK recognises. Used by `looksLikeSessionEvent` for the permissive guard.
 *
 * The shim strings are kept here so existing serialised event streams (relay
 * buffers, SSE replays, signed archives) whose `type` field was emitted before
 * 3.0.0 can still pass the guard. They are NOT emitted by the hub anymore.
 * @public
 */
export const ALL_KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  ...Object.keys(DOTTED_TO_CANONICAL),
  ...Object.values(DOTTED_TO_CANONICAL),
  ...CANONICAL_ONLY_TYPES,
]);

/**
 * Translate a legacy dotted-lowercase type to its canonical UPPER_SNAKE peer.
 * Already-canonical or unknown strings are returned unchanged (passthrough).
 *
 * Used internally at the hub emit boundary so callers can still pass legacy
 * types without breakage.
 *
 * @public @since 3.0.0
 */
export function toCanonicalEventType(type: string): string {
  // Already canonical (it maps back to a dotted form) → unchanged.
  if (CANONICAL_TO_DOTTED[type] !== undefined) return type;
  // Dotted → translate to canonical.
  if (DOTTED_TO_CANONICAL[type] !== undefined) {
    return DOTTED_TO_CANONICAL[type];
  }
  // Unknown → passthrough.
  return type;
}

/**
 * Return true if `type` is a known Vauban or AG-UI canonical event type.
 * The boundary is intentionally permissive ; consumers that need stricter
 * validation should `validateEvent` against the AG-UI spec separately.
 * @public
 */
export function isKnownEventType(type: string): boolean {
  return ALL_KNOWN_EVENT_TYPES.has(type);
}
