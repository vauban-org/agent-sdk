import { describe, expect, it } from "vitest";
import { type AlertItem, buildAlertDigest } from "../src/alerts/digest.js";

const critical: AlertItem = { severity: "critical", title: "Critical issue" };
const high: AlertItem = { severity: "high", title: "High issue" };
const medium: AlertItem = { severity: "medium", title: "Medium issue" };
const low: AlertItem = { severity: "low", title: "Low issue" };

// ── Empty / basic ───────────────────────────────────────────────────────────

describe("empty / basic", () => {
  it("1. empty array → returns []", () => {
    expect(buildAlertDigest([])).toEqual([]);
  });

  it("2. 1 item (default threshold=3) → returns array with 1 string", () => {
    const result = buildAlertDigest([high]);
    expect(result).toHaveLength(1);
    expect(typeof result[0]).toBe("string");
  });

  it("3. 3 items → returns array with 3 strings (individual mode)", () => {
    const result = buildAlertDigest([critical, high, medium]);
    expect(result).toHaveLength(3);
    result.forEach((r) => expect(typeof r).toBe("string"));
  });

  it("4. 4 items (above threshold=3) → returns array with 1 string (digest mode)", () => {
    const items: AlertItem[] = [critical, high, medium, low];
    const result = buildAlertDigest(items);
    expect(result).toHaveLength(1);
  });
});

// ── Individual mode formatting ───────────────────────────────────────────────

describe("individual mode formatting", () => {
  it("5. severity=critical → contains 🚨 emoji", () => {
    const [msg] = buildAlertDigest([critical]);
    expect(msg).toContain("🚨");
  });

  it("6. severity=high → contains ⚠️ emoji", () => {
    const [msg] = buildAlertDigest([high]);
    expect(msg).toContain("⚠️");
  });

  it("7. severity=medium → contains ℹ️ emoji", () => {
    const [msg] = buildAlertDigest([medium]);
    expect(msg).toContain("ℹ️");
  });

  it("8. severity=low → contains 🔵 emoji", () => {
    const [msg] = buildAlertDigest([low]);
    expect(msg).toContain("🔵");
  });

  it("9. item with component → individual message contains 'Component:' line", () => {
    const item: AlertItem = {
      severity: "high",
      title: "Dep vuln",
      component: "vauban-org/forge:axios",
    };
    const [msg] = buildAlertDigest([item]);
    expect(msg).toContain("Component: vauban-org/forge:axios");
  });

  it("10. item with remediation → individual message contains 'Remediation:' line", () => {
    const item: AlertItem = {
      severity: "medium",
      title: "Config leak",
      remediation: "Rotate secret immediately",
    };
    const [msg] = buildAlertDigest([item]);
    expect(msg).toContain("Remediation: Rotate secret immediately");
  });

  it("11. item with url → individual message contains the url", () => {
    const item: AlertItem = {
      severity: "high",
      title: "Vuln",
      url: "https://nvd.nist.gov/vuln/detail/CVE-2026-0001",
    };
    const [msg] = buildAlertDigest([item]);
    expect(msg).toContain("https://nvd.nist.gov/vuln/detail/CVE-2026-0001");
  });

  it("12. item with ref → message contains [ref] format", () => {
    const item: AlertItem = {
      severity: "critical",
      title: "Auth bypass",
      ref: "CVE-2026-0001",
    };
    const [msg] = buildAlertDigest([item]);
    expect(msg).toContain("[CVE-2026-0001]");
  });

  it("13. item with no optional fields → still renders correctly", () => {
    const item: AlertItem = { severity: "low", title: "Minor issue" };
    const [msg] = buildAlertDigest([item]);
    expect(msg).toBe("🔵 Minor issue");
  });
});

// ── Digest mode ──────────────────────────────────────────────────────────────

describe("digest mode", () => {
  const fiveItems: AlertItem[] = [
    { severity: "critical", title: "C1" },
    { severity: "high", title: "H1" },
    { severity: "medium", title: "M1" },
    { severity: "low", title: "L1" },
    { severity: "low", title: "L2" },
  ];

  it("14. 5 items → single digest message containing the header", () => {
    const result = buildAlertDigest(fiveItems);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("ALERT");
  });

  it("15. digest header contains count ('5 items')", () => {
    const [msg] = buildAlertDigest(fiveItems);
    expect(msg).toContain("5 items");
  });

  it("16. digest sorts critical before low", () => {
    const items: AlertItem[] = [
      { severity: "low", title: "Low first" },
      { severity: "critical", title: "Critical second" },
      { severity: "low", title: "Another low" },
      { severity: "high", title: "High" },
    ];
    const [msg] = buildAlertDigest(items);
    const critPos = msg!.indexOf("Critical second");
    const lowPos = msg!.indexOf("Low first");
    expect(critPos).toBeLessThan(lowPos);
  });

  it("17. digest with detailsPointer → contains 'Details:' line", () => {
    const [msg] = buildAlertDigest(fiveItems, {
      detailsPointer: "query Brain category=forge_alert",
    });
    expect(msg).toContain("Details: query Brain category=forge_alert");
  });

  it("18. digest with custom label → header contains the label", () => {
    const [msg] = buildAlertDigest(fiveItems, { label: "SECURITY" });
    expect(msg).toContain("SECURITY");
  });

  it("19. digest with custom threshold=2 → 3 items goes to digest mode", () => {
    const items: AlertItem[] = [critical, high, medium];
    const result = buildAlertDigest(items, { threshold: 2 });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("3 items");
  });

  it("20. unknown severity → falls back to '•' emoji", () => {
    const items: AlertItem[] = [
      { severity: "unknown-sev", title: "Unknown sev item" },
      { severity: "high", title: "H1" },
      { severity: "high", title: "H2" },
      { severity: "high", title: "H3" },
    ];
    const [msg] = buildAlertDigest(items);
    expect(msg).toContain("•");
  });

  it("21. digest with maxChars=50 → truncates with '… +N more'", () => {
    const items: AlertItem[] = Array.from({ length: 10 }, (_, i) => ({
      severity: "high" as const,
      title: `Issue number ${i} with a fairly long title`,
    }));
    const [msg] = buildAlertDigest(items, { maxChars: 50 });
    expect(msg).toContain("… +");
  });

  it("22. header breakdown shows non-zero counts (e.g. '2 critical, 1 high')", () => {
    const items: AlertItem[] = [
      { severity: "critical", title: "C1" },
      { severity: "critical", title: "C2" },
      { severity: "high", title: "H1" },
      { severity: "medium", title: "M1" },
    ];
    const [msg] = buildAlertDigest(items);
    expect(msg).toContain("2 critical");
    expect(msg).toContain("1 high");
  });

  it("23. items at exactly threshold → individual mode (not digest)", () => {
    // threshold default = 3; exactly 3 items → individual mode → 3 messages
    const items: AlertItem[] = [critical, high, medium];
    const result = buildAlertDigest(items);
    expect(result).toHaveLength(3);
  });

  it("24. custom emojiMap overrides emoji for severity", () => {
    const item: AlertItem = { severity: "critical", title: "Fire!" };
    const [msg] = buildAlertDigest([item], { emojiMap: { critical: "🔥" } });
    expect(msg).toContain("🔥");
    expect(msg).not.toContain("🚨");
  });
});
