/**
 * `createTracedBrainPort` must not invent a capability the implementation
 * does not have.
 *
 * Found 2026-08-29 while auditing a different defect of the same family. The
 * wrapper defined `queryKnowledge` unconditionally and opened it with
 * `if (!impl.queryKnowledge) return []`. Wrapping an implementation with no
 * query surface therefore produced a port where `port.queryKnowledge` is
 * truthy and answers `[]` forever.
 *
 * That is worse than a missing method. A caller feature-detecting the
 * capability is told it EXISTS, and then told there is NOTHING TO FIND, which
 * are two different facts and only one of them is true. Absence rendered as a
 * fact is the forbidden motif ADR-ECO-149 names, and it was sitting in the
 * module that defines the contract.
 */

import { describe, expect, it, vi } from "vitest";
import type { BrainEntry, BrainEntryInput, BrainPort } from "../src/ports/brain.js";
import { createTracedBrainPort } from "../src/ports/brain.js";

/** The minimum a BrainPort must have: archiveKnowledge and nothing else. */
function minimalPort(): BrainPort {
  return {
    archiveKnowledge: async (_e: BrainEntryInput): Promise<BrainEntry | null> => null,
  } as unknown as BrainPort;
}

describe("createTracedBrainPort ; optional stays optional", () => {
  it("leaves queryKnowledge ABSENT when the implementation has none", () => {
    const traced = createTracedBrainPort(minimalPort());
    // Not "returns []" : absent. Feature detection must give the same answer
    // before and after wrapping, or the wrapper is lying about the impl.
    expect(traced.queryKnowledge).toBeUndefined();
  });

  it("keeps feature detection honest through the wrapper", () => {
    const bare = minimalPort();
    const traced = createTracedBrainPort(bare);
    expect(Boolean(traced.queryKnowledge)).toBe(Boolean(bare.queryKnowledge));
  });

  it("still wraps and delegates queryKnowledge when the implementation has one", async () => {
    const rows = [{ id: "e1", content: "x" }] as unknown as BrainEntry[];
    const query = vi.fn(async () => rows);
    const impl = {
      archiveKnowledge: async (): Promise<BrainEntry | null> => null,
      queryKnowledge: query,
    } as unknown as BrainPort;

    const traced = createTracedBrainPort(impl);
    expect(traced.queryKnowledge).toBeTypeOf("function");
    await expect(traced.queryKnowledge?.("q", { limit: 3 })).resolves.toEqual(rows);
    // Delegation, not reimplementation: the filters reach the implementation.
    expect(query).toHaveBeenCalledWith("q", { limit: 3 });
  });

  it("lets a query failure through instead of flattening it to an empty list", async () => {
    const impl = {
      archiveKnowledge: async (): Promise<BrainEntry | null> => null,
      queryKnowledge: async () => {
        throw new Error("brain unreachable");
      },
    } as unknown as BrainPort;
    const traced = createTracedBrainPort(impl);
    await expect(traced.queryKnowledge?.("q")).rejects.toThrow("brain unreachable");
  });
});
