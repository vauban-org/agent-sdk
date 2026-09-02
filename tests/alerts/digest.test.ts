/**
 * Tests for buildAlertDigest (SDK 1.9.0).
 *
 * Promoted from forge's security-auditor `buildEscalationMessages()` after
 * the 47-alert Telegram flood on the first Dependabot-enabled cycle
 * (2026-05-17). Validates threshold/sort/cap/footer behaviour with
 * customizable severityOrder + emojiMap.
 */

import { describe, expect, it } from "vitest";
import { type AlertItem, buildAlertDigest } from "../../src/alerts/digest.js";

function mk(
  severity: AlertItem["severity"],
  title: string,
  overrides: Partial<AlertItem> = {},
): AlertItem {
  return {
    severity,
    title,
    component: "comp",
    ref: "CVE-2026-0001",
    remediation: "upgrade",
    ...overrides,
  };
}

describe("buildAlertDigest", () => {
  it("returns [] on empty input", () => {
    expect(buildAlertDigest([])).toEqual([]);
  });

  it("returns N individual messages when count <= threshold (default 3)", () => {
    for (const n of [1, 2, 3]) {
      const items = Array.from({ length: n }, (_, i) => mk("high", `finding-${i}`));
      const out = buildAlertDigest(items);
      expect(out).toHaveLength(n);
      expect(out[0]).toContain("finding-0");
      expect(out[0]).toContain("[CVE-2026-0001]");
      expect(out[0]).toContain("Component: comp");
      expect(out[0]).toContain("Remediation: upgrade");
      // default high emoji
      expect(out[0]!.startsWith("⚠️")).toBe(true);
    }
  });

  it("returns 1 digest message, critical-first, when count > threshold", () => {
    const items: AlertItem[] = [
      mk("high", "h1"),
      mk("critical", "c1"),
      mk("high", "h2"),
      mk("critical", "c2"),
    ];
    const out = buildAlertDigest(items);
    expect(out).toHaveLength(1);
    const body = out[0]!;
    expect(body).toContain("ALERT — 4 items (2 critical, 2 high)");
    const cIdx = body.indexOf("c1");
    const hIdx = body.indexOf("h1");
    expect(cIdx).toBeGreaterThan(0);
    expect(hIdx).toBeGreaterThan(0);
    expect(cIdx).toBeLessThan(hIdx);
  });

  it("caps digest at maxChars=4000 with 200+ items and emits truncation footer", () => {
    const items = Array.from({ length: 250 }, (_, i) =>
      mk("high", `very-long-title-finding-${i}-${"x".repeat(80)}`, {
        component: `repo-${i}/package-name`,
        ref: `CVE-2026-${String(i).padStart(4, "0")}`,
      }),
    );
    const out = buildAlertDigest(items, {
      detailsPointer: "query Brain category=forge_alert",
    });
    expect(out).toHaveLength(1);
    const body = out[0]!;
    expect(body.length).toBeLessThanOrEqual(4000);
    expect(body).toMatch(/… \+\d+ more/);
    expect(body).toContain("Details: query Brain category=forge_alert");
  });

  it("custom severityOrder honored — high listed before critical", () => {
    const items: AlertItem[] = [
      mk("critical", "c1"),
      mk("high", "h1"),
      mk("critical", "c2"),
      mk("high", "h2"),
    ];
    const out = buildAlertDigest(items, {
      severityOrder: ["high", "critical", "medium"],
    });
    const body = out[0]!;
    expect(body).toContain("ALERT — 4 items (2 high, 2 critical)");
    const hIdx = body.indexOf("h1");
    const cIdx = body.indexOf("c1");
    expect(hIdx).toBeLessThan(cIdx);
  });

  it("custom emojiMap honored", () => {
    const items = Array.from({ length: 5 }, (_, i) => mk("critical", `c-${i}`));
    const out = buildAlertDigest(items, {
      emojiMap: { critical: "🔥", high: "❗" },
    });
    expect(out[0]!.startsWith("🔥")).toBe(true);
    // body lines also use the custom emoji
    expect(out[0]).toMatch(/🔥 c-0/);
  });

  it("severity not in order goes last with fallback emoji '•'", () => {
    const items: AlertItem[] = [
      mk("info", "info-1"),
      mk("critical", "crit-1"),
      mk("info", "info-2"),
      mk("critical", "crit-2"),
      mk("info", "info-3"),
    ];
    const out = buildAlertDigest(items);
    const body = out[0]!;
    const critIdx = body.indexOf("crit-1");
    const infoIdx = body.indexOf("info-1");
    expect(critIdx).toBeGreaterThan(0);
    expect(infoIdx).toBeGreaterThan(0);
    expect(critIdx).toBeLessThan(infoIdx);
    expect(body).toMatch(/• info-1/);
  });

  it("header counts only non-zero severities", () => {
    const items = [
      ...Array.from({ length: 12 }, (_, i) => mk("critical", `c-${i}`)),
      ...Array.from({ length: 35 }, (_, i) => mk("high", `h-${i}`)),
    ];
    const out = buildAlertDigest(items, { label: "SECURITY" });
    const body = out[0]!;
    expect(body).toContain("SECURITY — 47 items (12 critical, 35 high)");
    expect(body).not.toContain("0 medium");
    expect(body).not.toContain("0 low");
  });

  it("truncation cuts at line boundary — no half-line in output", () => {
    const items = Array.from({ length: 300 }, (_, i) =>
      mk("high", `finding-${i}-${"x".repeat(50)}`),
    );
    const out = buildAlertDigest(items);
    const body = out[0]!;
    expect(body.length).toBeLessThanOrEqual(4000);
    // every body line is either the header, an item line ending in
    // "— comp" (or "— ?"), the truncation marker, or the footer.
    const lines = body.split("\n");
    for (const ln of lines) {
      if (ln.startsWith("⚠️") || ln.startsWith("🚨")) {
        // alert body line: must end with the component segment
        expect(ln).toMatch(/ — .+$/);
      }
    }
  });

  it("does NOT append truncation footer when all items fit", () => {
    const items = Array.from({ length: 5 }, (_, i) => mk("high", `f-${i}`));
    const out = buildAlertDigest(items, {
      detailsPointer: "query Brain category=forge_alert",
    });
    const body = out[0]!;
    expect(body).not.toMatch(/… \+\d+ more/);
    expect(body).toContain("Details: query Brain category=forge_alert");
  });
});
