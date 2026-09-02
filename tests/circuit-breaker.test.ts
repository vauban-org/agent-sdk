import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetCircuitBreaker } from "../src/economy/circuit-breaker.js";

describe("FleetCircuitBreaker — initial state", () => {
  it("starts closed", () => {
    const cb = new FleetCircuitBreaker();
    expect(cb.state).toBe("closed");
  });

  it("canProceed() returns true when closed with no spend", () => {
    const cb = new FleetCircuitBreaker();
    expect(cb.canProceed()).toBe(true);
  });

  it("windowSpend starts at 0", () => {
    const cb = new FleetCircuitBreaker();
    expect(cb.windowSpend).toBe(0);
  });
});

describe("FleetCircuitBreaker — cost accumulation", () => {
  it("recordCost() accumulates windowSpend", () => {
    const cb = new FleetCircuitBreaker({ thresholdUsd: 10 });
    cb.recordCost(3);
    cb.recordCost(4);
    expect(cb.windowSpend).toBe(7);
  });

  it("remains closed below threshold", () => {
    const cb = new FleetCircuitBreaker({ thresholdUsd: 10 });
    cb.recordCost(5);
    expect(cb.state).toBe("closed");
    expect(cb.canProceed()).toBe(true);
  });
});

describe("FleetCircuitBreaker — trips to open", () => {
  it("trips to open when windowSpend exceeds threshold", () => {
    const cb = new FleetCircuitBreaker({ thresholdUsd: 10 });
    cb.recordCost(11);
    expect(cb.state).toBe("open");
  });

  it("canProceed() returns false when open", () => {
    const cb = new FleetCircuitBreaker({ thresholdUsd: 10 });
    cb.recordCost(11);
    expect(cb.canProceed()).toBe(false);
  });

  it("canProceed() trips when spend at threshold boundary during check", () => {
    const cb = new FleetCircuitBreaker({ thresholdUsd: 10 });
    cb.recordCost(10.0); // exactly at threshold — should not trip (> not >=)
    expect(cb.state).toBe("closed");
    cb.recordCost(0.01); // now > threshold
    expect(cb.state).toBe("open");
  });
});

describe("FleetCircuitBreaker — cooldown and half-open", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stays open before cooldown elapses", () => {
    const cb = new FleetCircuitBreaker({ thresholdUsd: 10, cooldownMs: 300_000 });
    cb.recordCost(15);
    vi.advanceTimersByTime(100_000);
    expect(cb.canProceed()).toBe(false);
    expect(cb.state).toBe("open");
  });

  it("transitions to half-open after cooldown", () => {
    const cb = new FleetCircuitBreaker({ thresholdUsd: 10, cooldownMs: 300_000 });
    cb.recordCost(15);
    vi.advanceTimersByTime(300_001);
    expect(cb.canProceed()).toBe(true);
    expect(cb.state).toBe("half-open");
  });

  it("half-open: canProceed() true for exactly ONE call", () => {
    const cb = new FleetCircuitBreaker({ thresholdUsd: 10, cooldownMs: 300_000 });
    cb.recordCost(15);
    vi.advanceTimersByTime(300_001);
    expect(cb.canProceed()).toBe(true); // first call
    expect(cb.canProceed()).toBe(false); // second call blocked
  });

  it("half-open: probe cost within threshold → transitions to closed", () => {
    const cb = new FleetCircuitBreaker({
      thresholdUsd: 10,
      cooldownMs: 300_000,
      windowMs: 3_600_000,
    });
    // Trip with cost that will expire from window
    cb.recordCost(15);
    // Advance past window + cooldown so old entry evicts
    vi.advanceTimersByTime(3_700_000);
    cb.canProceed(); // transition to half-open
    cb.recordCost(1); // probe cost within threshold (window is empty)
    expect(cb.state).toBe("closed");
  });

  it("half-open: probe cost exceeds threshold → re-trips to open", () => {
    const cb = new FleetCircuitBreaker({
      thresholdUsd: 10,
      cooldownMs: 300_000,
      windowMs: 3_600_000,
    });
    cb.recordCost(15);
    // Advance past window to clear spend, then past cooldown
    vi.advanceTimersByTime(3_700_000);
    cb.canProceed(); // half-open
    cb.recordCost(11); // exceeds threshold
    expect(cb.state).toBe("open");
  });

  it("sliding window evicts old entries", () => {
    const cb = new FleetCircuitBreaker({
      thresholdUsd: 10,
      windowMs: 3_600_000,
      cooldownMs: 300_000,
    });
    cb.recordCost(8);
    vi.advanceTimersByTime(3_600_001); // entry expires
    cb.recordCost(0); // triggers eviction
    expect(cb.windowSpend).toBe(0);
  });
});

describe("FleetCircuitBreaker — reset()", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reset() returns to closed state", () => {
    const cb = new FleetCircuitBreaker({ thresholdUsd: 10 });
    cb.recordCost(15);
    expect(cb.state).toBe("open");
    cb.reset();
    expect(cb.state).toBe("closed");
  });

  it("reset() clears spend history", () => {
    const cb = new FleetCircuitBreaker({ thresholdUsd: 10 });
    cb.recordCost(8);
    cb.reset();
    expect(cb.windowSpend).toBe(0);
  });

  it("reset() from open allows canProceed()", () => {
    const cb = new FleetCircuitBreaker({ thresholdUsd: 10 });
    cb.recordCost(15);
    cb.reset();
    expect(cb.canProceed()).toBe(true);
  });
});

describe("FleetCircuitBreaker — custom config", () => {
  it("respects custom thresholdUsd", () => {
    const cb = new FleetCircuitBreaker({ thresholdUsd: 5 });
    cb.recordCost(6);
    expect(cb.state).toBe("open");
  });

  it("uses default config when none provided", () => {
    const cb = new FleetCircuitBreaker();
    // Default threshold = 10.0, should not trip on small cost
    cb.recordCost(1);
    expect(cb.state).toBe("closed");
  });
});
