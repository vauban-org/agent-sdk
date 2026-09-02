/**
 * alerts/ — Adaptive notification batching (SDK 1.9.0).
 *
 * Promoted from forge's security-auditor `buildEscalationMessages()`
 * after the 47-alert Telegram flood (2026-05-17). Pure, transport-agnostic
 * helper; caller dispatches the returned strings.
 *
 * @public
 */

export { buildAlertDigest } from "./digest.js";
export type { AlertItem, AlertDigestOptions } from "./digest.js";
