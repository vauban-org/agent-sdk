/**
 * pod-start-progress-event.test ; V2-C mission-control progress rail. During a
 * pod start the origin emits `CUSTOM_POD_START_PROGRESS` SessionEvents on the
 * observe leg at each governance-pipeline boundary (requested -> approved ->
 * cert_minted -> committed -> reconciling -> announced), so the phone renders a
 * named-state timeline instead of dead silence between the tap and the pod.
 *
 * ANTI-ORACLE: this rides the OBSERVE leg only, never the control ACK (which
 * stays `{steerId, accepted}`). A `failed` stage carries at most a STRUCTURAL
 * `detail` reason ; it never carries the task/repo VALUE (`<external_data>`).
 */

import { describe, expect, it } from "vitest";
import {
  POD_START_STAGES,
  PodStartProgressPayloadSchema,
  SessionEventSchema,
  __resetEventSeq,
  isKnownEventType,
  makeEvent,
} from "../src/remote/index.js";

describe("CUSTOM_POD_START_PROGRESS SessionEvent (V2-C)", () => {
  it("is a known event type and round-trips a nominal stage through the schema", () => {
    __resetEventSeq();
    const ev = makeEvent("CUSTOM_POD_START_PROGRESS", { stage: "committed" });
    expect(ev.type).toBe("CUSTOM_POD_START_PROGRESS");
    expect(isKnownEventType("CUSTOM_POD_START_PROGRESS")).toBe(true);
    const parsed = SessionEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "CUSTOM_POD_START_PROGRESS") {
      expect(parsed.data.data.stage).toBe("committed");
      expect(parsed.data.data.failed).toBeUndefined();
      expect(parsed.data.data.detail).toBeUndefined();
    }
  });

  it("round-trips a terminal failure stage with a structural detail reason", () => {
    const ev = makeEvent("CUSTOM_POD_START_PROGRESS", {
      stage: "approved",
      failed: true,
      detail: "denied",
    });
    const parsed = SessionEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "CUSTOM_POD_START_PROGRESS") {
      expect(parsed.data.data.stage).toBe("approved");
      expect(parsed.data.data.failed).toBe(true);
      expect(parsed.data.data.detail).toBe("denied");
    }
  });

  it("names exactly the six governance-pipeline boundaries in order", () => {
    expect(POD_START_STAGES).toEqual([
      "requested",
      "approved",
      "cert_minted",
      "committed",
      "reconciling",
      "announced",
    ]);
  });

  it("accepts every declared stage", () => {
    for (const stage of POD_START_STAGES) {
      const r = PodStartProgressPayloadSchema.safeParse({ stage });
      expect(r.success).toBe(true);
    }
  });

  it("rejects a stage outside the enum (the enum is the wire contract)", () => {
    const bad = PodStartProgressPayloadSchema.safeParse({ stage: "provisioning" });
    expect(bad.success).toBe(false);
  });

  it("rejects an unknown extra field (.strict, no smuggled external_data)", () => {
    const bad = PodStartProgressPayloadSchema.safeParse({
      stage: "committed",
      repo: "https://github.com/private/secret", // .strict() must reject a smuggled value
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a non-string detail and a non-boolean failed", () => {
    expect(PodStartProgressPayloadSchema.safeParse({ stage: "committed", detail: 5 }).success).toBe(
      false,
    );
    expect(
      PodStartProgressPayloadSchema.safeParse({ stage: "committed", failed: "yes" }).success,
    ).toBe(false);
  });
});
