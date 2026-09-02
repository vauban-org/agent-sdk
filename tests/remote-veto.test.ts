/**
 * Tests for the VetoChannel — pre-tool-call veto bus (T6a).
 *
 * Three properties matter:
 *   - submit-before-await — a signal that arrives before the AgentLoop
 *     starts waiting must NOT be lost (the loop registers its waiter only
 *     after emitting tool.intent, so a fast remote can race the loop).
 *   - await timeout — when no signal arrives, the wait resolves null after
 *     exactly the configured window so the loop proceeds with the tool call.
 *   - call-scoped — a signal for a different callId never satisfies an
 *     unrelated wait.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryVetoChannel } from "../src/remote/index.js";

describe("InMemoryVetoChannel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a buffered signal when submit precedes await", async () => {
    const ch = new InMemoryVetoChannel();
    ch.submit({
      callId: "c1",
      by: "remote-http",
      at: new Date().toISOString(),
    });
    expect(ch.pendingCount()).toBe(1);

    const out = await ch.await("c1", 5_000);
    expect(out?.callId).toBe("c1");
    expect(out?.by).toBe("remote-http");
    // Buffered signal is consumed.
    expect(ch.pendingCount()).toBe(0);
  });

  it("delivers a signal that arrives while the loop is already waiting", async () => {
    const ch = new InMemoryVetoChannel();
    const p = ch.await("c2", 5_000);
    ch.submit({
      callId: "c2",
      by: "telegram:1",
      reason: "wrong path",
      at: new Date().toISOString(),
    });
    const out = await p;
    expect(out?.callId).toBe("c2");
    expect(out?.reason).toBe("wrong path");
  });

  it("resolves null exactly at the window when no signal arrives", async () => {
    const ch = new InMemoryVetoChannel();
    const p = ch.await("c3", 200);
    await vi.advanceTimersByTimeAsync(199);
    // Not yet — still waiting.
    const racing = await Promise.race([p.then(() => "resolved"), Promise.resolve("pending")]);
    expect(racing).toBe("pending");

    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBeNull();
  });

  it("returns null synchronously when windowMs is 0", async () => {
    const ch = new InMemoryVetoChannel();
    expect(await ch.await("c4", 0)).toBeNull();
  });

  it("does not satisfy an unrelated wait with a different callId", async () => {
    const ch = new InMemoryVetoChannel();
    const p = ch.await("c5", 200);
    ch.submit({ callId: "OTHER", by: "x", at: new Date().toISOString() });
    await vi.advanceTimersByTimeAsync(200);
    expect(await p).toBeNull();
    // The unrelated signal stays buffered for whoever asks for it.
    expect(ch.pendingCount()).toBe(1);
  });
});
