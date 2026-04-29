/**
 * Tests for the deprecation() helper (Sprint-457).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _deprecationWarnedCallSites,
  _resetDeprecationWarnings,
  deprecated,
} from "../src/deprecation.js";

afterEach(() => {
  _resetDeprecationWarnings();
  vi.restoreAllMocks();
});

describe("deprecated()", () => {
  it("emits exactly one warning per call-site", () => {
    const emit = vi.fn();

    function callOne() {
      deprecated("oldApi", { since: "0.3.0", emit });
    }

    callOne();
    callOne();
    callOne();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toContain("[deprecated] oldApi");
    expect(emit.mock.calls[0][0]).toContain("since 0.3.0");
  });

  it("emits again when called from a different source-location", () => {
    const emit = vi.fn();

    function fromA() {
      deprecated("oldApi", { emit });
    }
    function fromB() {
      deprecated("oldApi", { emit });
    }

    fromA();
    fromA();
    fromB();
    fromB();

    // 2 distinct call-sites → exactly 2 warnings total.
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("includes replacement, removeIn, and note in the message", () => {
    const emit = vi.fn();

    deprecated("oldApi", {
      since: "0.3.0",
      removeIn: "0.5.0",
      replacement: "newApi",
      note: "breaking data shape",
      emit,
    });

    const msg = emit.mock.calls[0][0] as string;
    expect(msg).toContain("since 0.3.0");
    expect(msg).toContain("removing in 0.5.0");
    expect(msg).toContain("use newApi");
    expect(msg).toContain("breaking data shape");
    expect(msg).toContain("call-site:");
  });

  it("_deprecationWarnedCallSites reflects emitted warnings", () => {
    const emit = vi.fn();
    deprecated("oldApi", { emit });
    expect(_deprecationWarnedCallSites().length).toBe(1);

    _resetDeprecationWarnings();
    expect(_deprecationWarnedCallSites().length).toBe(0);
  });

  it("defaults emit to console.warn", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    deprecated("consoleApi");
    expect(spy).toHaveBeenCalledOnce();
  });
});
