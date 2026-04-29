/**
 * sdk-permission-mapping tests — pure projections, intersection semantics.
 */

import { describe, expect, it } from "vitest";
import {
  capabilityToSdkPermissions,
  scopeToSdkPermissions,
} from "../src/sdk-permission-mapping.js";

describe("scopeToSdkPermissions", () => {
  it("cc:read → bash:off, fileIo:read-only, mcp brain/citadel:read", () => {
    expect(scopeToSdkPermissions("cc:read")).toEqual({
      bash: "off",
      fileIo: "read-only",
      mcp: ["brain:read", "citadel:read"],
    });
  });

  it("cc:execute → bash:restricted, fileIo:sandboxed-tmp, mcp brain/citadel:write", () => {
    expect(scopeToSdkPermissions("cc:execute")).toEqual({
      bash: "restricted",
      fileIo: "sandboxed-tmp",
      mcp: ["brain:write", "citadel:write"],
    });
  });

  it("cc:admin → mcp includes admin scopes", () => {
    expect(scopeToSdkPermissions("cc:admin").mcp).toContain("brain:admin");
  });

  it("returns a fresh object on each call (no shared mutable state)", () => {
    const a = scopeToSdkPermissions("cc:read");
    a.mcp.push("evil");
    const b = scopeToSdkPermissions("cc:read");
    expect(b.mcp).not.toContain("evil");
  });
});

describe("capabilityToSdkPermissions", () => {
  it("empty tools → no MCP regardless of scope", () => {
    expect(capabilityToSdkPermissions("cc:admin", []).mcp).toEqual([]);
    expect(capabilityToSdkPermissions("cc:read", []).mcp).toEqual([]);
    expect(capabilityToSdkPermissions("cc:execute", []).mcp).toEqual([]);
  });

  it("tools=[fetchRss] excludes brain:write (no MCP scope mapped)", () => {
    const p = capabilityToSdkPermissions("cc:execute", ["fetchRss"]);
    expect(p.mcp).not.toContain("brain:write");
    expect(p.mcp).toEqual([]);
  });

  it("intersects requested MCP sub-scopes with the cc:* grant", () => {
    // cc:execute grants brain:write; the agent's token requests brain:write.
    const p = capabilityToSdkPermissions("cc:execute", ["archiveKnowledge"]);
    expect(p.mcp).toEqual(["brain:write"]);
  });

  it("strips MCP scopes the cc:* layer does not grant", () => {
    // cc:read does NOT grant brain:write — even though the tool requests it.
    const p = capabilityToSdkPermissions("cc:read", ["archiveKnowledge"]);
    expect(p.mcp).not.toContain("brain:write");
  });

  it("preserves bash + fileIo from the scope projection", () => {
    const p = capabilityToSdkPermissions("cc:execute", ["queryKnowledge"]);
    expect(p.bash).toBe("restricted");
    expect(p.fileIo).toBe("sandboxed-tmp");
  });

  it("accepts pre-namespaced tools as identity (brain:read, citadel:read)", () => {
    const p = capabilityToSdkPermissions("cc:read", ["brain:read"]);
    expect(p.mcp).toContain("brain:read");
  });

  it("ignores unknown tool names (no silent grant)", () => {
    const p = capabilityToSdkPermissions("cc:execute", ["totallyMadeUp"]);
    expect(p.mcp).toEqual([]);
  });

  it("returns a fresh object — does not mutate baseline", () => {
    const a = capabilityToSdkPermissions("cc:read", ["queryKnowledge"]);
    a.mcp.push("evil");
    const b = capabilityToSdkPermissions("cc:read", ["queryKnowledge"]);
    expect(b.mcp).not.toContain("evil");
  });
});
