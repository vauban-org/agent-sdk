/**
 * alerts/digest.ts — Adaptive notification batching (SDK 1.9.0).
 *
 * Promoted from forge's `src/agents/23-security-auditor/agent.ts`
 * `buildEscalationMessages()` after a 47-alert Telegram flood during the
 * first Dependabot-enabled cycle (2026-05-17). Generalized so any agent
 * dispatching bulk operator alerts (devops, finance, devrel, inbox-monitor,
 * security-auditor) can adopt it without re-implementing the
 * threshold/sort/cap logic.
 *
 * Design notes:
 *  - Pure function — no I/O, no transport dependency. Caller dispatches the
 *    returned strings to Telegram/Slack/email/whatever channel.
 *  - 0 items → no message at all (empty array).
 *  - 1..threshold items → one full-detail message per item.
 *  - More than threshold items → one digest message, sorted by severity
 *    (configurable order), capped at `maxChars`, with truncation footer +
 *    optional details pointer.
 *  - Severities outside the configured order are appended last with a
 *    default bullet emoji.
 *
 * @public
 */

/**
 * A single alert item fed to {@link buildAlertDigest}. All fields except
 * `severity` and `title` are optional — render skips empty lines.
 *
 * @public
 */
export interface AlertItem {
  /**
   * Severity bucket. Built-in semantics: `"critical" | "high" | "medium" |
   * "low"`. Any other string is accepted and ranked according to
   * {@link AlertDigestOptions.severityOrder} (or appended last with a
   * default emoji when not listed).
   */
  readonly severity: "critical" | "high" | "medium" | "low" | (string & Record<never, never>);
  /** Human-readable headline (rendered after the emoji). */
  readonly title: string;
  /** Affected component / repo / file (e.g. `"vauban-org/forge:axios"`). */
  readonly component?: string;
  /** External reference (e.g. `"CVE-2026-0001"`). */
  readonly ref?: string;
  /** Remediation hint shown in individual messages. */
  readonly remediation?: string;
  /** Direct URL for follow-up (shown in individual messages). */
  readonly url?: string;
}

/**
 * Options for {@link buildAlertDigest}. All fields optional with sensible
 * defaults matching forge's prod-validated security-auditor behaviour.
 *
 * @public
 */
export interface AlertDigestOptions {
  /**
   * Header prefix label (e.g. `"SECURITY"`, `"DEVOPS"`). Default
   * `"ALERT"`. Appears in the digest header — ignored in per-item mode.
   */
  readonly label?: string;
  /**
   * Cutoff between per-item and digest modes. `<=` threshold yields N
   * messages, `>` threshold yields a single digest. Default `3`.
   */
  readonly threshold?: number;
  /**
   * Hard cap on the rendered digest length (chars). Default `4000`
   * (Telegram-safe — Telegram limit is 4096).
   */
  readonly maxChars?: number;
  /**
   * Pointer to detailed source (e.g. `"query Brain category=forge_alert"`).
   * Appended on a final line of every digest message when provided.
   */
  readonly detailsPointer?: string;
  /**
   * Severity sort order, highest priority first. Default
   * `["critical", "high", "medium", "low"]`. Severities not listed go
   * after listed ones, in input order.
   */
  readonly severityOrder?: readonly string[];
  /**
   * Per-severity emoji map. Default
   * `{ critical: "🚨", high: "⚠️", medium: "ℹ️", low: "🔵" }`. Missing
   * severities fall back to `"•"`.
   */
  readonly emojiMap?: Readonly<Record<string, string>>;
}

const DEFAULT_THRESHOLD = 3;
const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_LABEL = "ALERT";
const DEFAULT_SEVERITY_ORDER: readonly string[] = ["critical", "high", "medium", "low"];
const DEFAULT_EMOJI_MAP: Readonly<Record<string, string>> = {
  critical: "🚨",
  high: "⚠️",
  medium: "ℹ️",
  low: "🔵",
};
const FALLBACK_EMOJI = "•";

function emojiFor(severity: string, map: Readonly<Record<string, string>>): string {
  return map[severity] ?? FALLBACK_EMOJI;
}

function severityRank(severity: string, order: readonly string[]): number {
  const idx = order.indexOf(severity);
  return idx === -1 ? order.length : idx;
}

function renderIndividual(item: AlertItem, emojiMap: Readonly<Record<string, string>>): string {
  const emoji = emojiFor(item.severity, emojiMap);
  const ref = item.ref ? ` [${item.ref}]` : "";
  const lines: string[] = [`${emoji} ${item.title}${ref}`];
  if (item.component) lines.push(`Component: ${item.component}`);
  if (item.remediation) lines.push(`Remediation: ${item.remediation}`);
  if (item.url) lines.push(item.url);
  return lines.join("\n");
}

function buildHeader(
  label: string,
  total: number,
  counts: ReadonlyMap<string, number>,
  order: readonly string[],
  emojiMap: Readonly<Record<string, string>>,
): string {
  const breakdown: string[] = [];
  for (const sev of order) {
    const c = counts.get(sev) ?? 0;
    if (c > 0) breakdown.push(`${c} ${sev}`);
  }
  const topSev = order.find((s) => (counts.get(s) ?? 0) > 0);
  const headEmoji = topSev ? emojiFor(topSev, emojiMap) : FALLBACK_EMOJI;
  const breakdownStr = breakdown.length > 0 ? ` (${breakdown.join(", ")})` : "";
  return `${headEmoji} ${label} — ${total} items${breakdownStr}`;
}

/**
 * Build an adaptive alert digest from a list of items.
 *
 * - 0 items → `[]` (no message at all).
 * - 1..threshold items → one message per item (full detail preserved).
 * - More than threshold → one digest message, severity-sorted, capped at
 *   `maxChars`, with truncation footer `"… +K more"` when items overflow,
 *   followed by `"Details: <detailsPointer>"` when a pointer is provided.
 *
 * Header counts only non-zero severities, in the configured order.
 * Severities not in `severityOrder` are appended last with a default
 * bullet emoji `"•"` (or a user-provided emoji from `emojiMap`).
 *
 * @example
 *   buildAlertDigest([])                             // → []
 *   buildAlertDigest([critical, high, low])          // → 3 messages
 *   buildAlertDigest(arrayOf(50, "high"), {
 *     label: "DEPENDABOT",
 *     detailsPointer: "query Brain category=forge_alert tag=security",
 *   })                                                // → 1 digest message
 *
 * @public
 */
export function buildAlertDigest(
  items: readonly AlertItem[],
  opts: AlertDigestOptions = {},
): string[] {
  if (items.length === 0) return [];

  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const label = opts.label ?? DEFAULT_LABEL;
  const severityOrder = opts.severityOrder ?? DEFAULT_SEVERITY_ORDER;
  const emojiMap = opts.emojiMap ?? DEFAULT_EMOJI_MAP;
  const detailsPointer = opts.detailsPointer;

  if (items.length <= threshold) {
    return items.map((it) => renderIndividual(it, emojiMap));
  }

  // Sort copy: by severityOrder rank, then preserve input order (stable).
  const sorted = items
    .map((it, idx) => ({ it, idx }))
    .sort((a, b) => {
      const ra = severityRank(a.it.severity, severityOrder);
      const rb = severityRank(b.it.severity, severityOrder);
      if (ra !== rb) return ra - rb;
      return a.idx - b.idx;
    })
    .map((x) => x.it);

  const counts = new Map<string, number>();
  for (const it of sorted) {
    counts.set(it.severity, (counts.get(it.severity) ?? 0) + 1);
  }

  const header = buildHeader(label, items.length, counts, severityOrder, emojiMap);
  const footerLines: string[] = [];
  if (detailsPointer) footerLines.push(`Details: ${detailsPointer}`);

  // Compute fixed cost: header + body lines + footer.
  // We need to leave room for an eventual "… +K more" line.
  const truncationLineEstimate = 16; // "\n… +999 more"
  const footerStr = footerLines.length > 0 ? `\n${footerLines.join("\n")}` : "";

  const bodyLines: string[] = [];
  let renderedSoFar = header.length;
  let truncated = 0;

  for (let i = 0; i < sorted.length; i++) {
    const it = sorted[i];
    const emoji = emojiFor(it.severity, emojiMap);
    const ref = it.ref ? ` [${it.ref}]` : "";
    const line = `${emoji} ${it.title}${ref} — ${it.component ?? "?"}`;
    // +1 for the leading "\n" before this line
    const lineCost = 1 + line.length;
    const remainingItems = sorted.length - i;
    // If adding this line would prevent us from fitting truncation footer
    // for the remaining items, stop here.
    const projected =
      renderedSoFar +
      lineCost +
      footerStr.length +
      (remainingItems > 1 ? truncationLineEstimate : 0);
    if (projected > maxChars) {
      truncated = sorted.length - i;
      break;
    }
    bodyLines.push(line);
    renderedSoFar += lineCost;
  }

  const out: string[] = [header, ...bodyLines];
  if (truncated > 0) out.push(`… +${truncated} more`);
  if (footerLines.length > 0) out.push(...footerLines);

  return [out.join("\n")];
}
