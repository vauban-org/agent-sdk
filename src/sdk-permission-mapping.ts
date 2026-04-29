/**
 * sdk-permission-mapping — pure projections from `cc:*` scope + Biscuit
 * tool list onto the SDK's runtime permission envelope.
 *
 * Two surfaces:
 *  - `scopeToSdkPermissions(scope)` mirrors the JWT-only path used in
 *    `mapScopesToSdkPermissions` but takes a SINGLE scope value (handier
 *    for code paths that already know the resolved scope).
 *  - `capabilityToSdkPermissions(scope, tools)` returns the INTERSECTION
 *    of the static scope projection and the agent's dynamic Biscuit tool
 *    allowlist. Tools that don't grant MCP capability remove `mcp:*`
 *    permissions; an empty tool list strips MCP entirely regardless of
 *    scope.
 *
 * Both functions are PURE (no IO, no globals). The empty-tools case is
 * called out explicitly so a misconfigured agent token cannot quietly
 * inherit the scope's full surface.
 */

export type CcScope = "cc:read" | "cc:execute" | "cc:admin";

export type FileIoMode = "off" | "read-only" | "sandboxed-tmp";
export type BashMode = "off" | "restricted";

/**
 * Permission envelope produced by this module. Distinct from the
 * `SdkPermissions` shape in `permissions/sdk-permissions.ts`: that one is
 * tightly coupled to the SDK loop, this one is a stable shape for hosts
 * computing intersections (no readonly arrays — caller may freeze).
 */
export interface SdkPermissions {
  bash: BashMode;
  fileIo: FileIoMode;
  mcp: string[];
}

const READ_PERMS: SdkPermissions = {
  bash: "off",
  fileIo: "read-only",
  mcp: ["brain:read", "citadel:read"],
};

const EXECUTE_PERMS: SdkPermissions = {
  bash: "restricted",
  fileIo: "sandboxed-tmp",
  mcp: ["brain:write", "citadel:write"],
};

const ADMIN_PERMS: SdkPermissions = {
  bash: "restricted",
  fileIo: "sandboxed-tmp",
  mcp: ["brain:write", "citadel:write", "brain:admin", "citadel:admin"],
};

/** Project a single `cc:*` scope onto SdkPermissions. Pure. */
export function scopeToSdkPermissions(scope: CcScope): SdkPermissions {
  switch (scope) {
    case "cc:read":
      return clone(READ_PERMS);
    case "cc:execute":
      return clone(EXECUTE_PERMS);
    case "cc:admin":
      return clone(ADMIN_PERMS);
  }
}

/**
 * Map a Biscuit tool name to an MCP sub-scope. The mapping is conservative:
 * unknown tools grant NO MCP scope. Hosts may extend this map by
 * passing tools that match a known prefix (e.g. `brain:*`, `citadel:*`).
 */
function toolToMcpScope(tool: string): string | null {
  if (tool === "brainQuery" || tool === "queryKnowledge") return "brain:read";
  if (tool === "brainArchive" || tool === "archiveKnowledge")
    return "brain:write";
  if (tool === "citadelRead") return "citadel:read";
  if (tool === "citadelWrite" || tool === "createTask") return "citadel:write";
  // Pre-namespaced (e.g. "brain:read") → identity if the prefix is known.
  if (
    tool.startsWith("brain:") ||
    tool.startsWith("citadel:") ||
    tool.startsWith("starknet:")
  ) {
    return tool;
  }
  return null;
}

/**
 * Compute the INTERSECTION of `scopeToSdkPermissions(scope)` and the
 * agent's tool allowlist. Tools that don't unlock MCP scopes do not
 * grant MCP. An empty tool list strips MCP entirely.
 */
export function capabilityToSdkPermissions(
  scope: CcScope,
  tools: readonly string[],
): SdkPermissions {
  const base = scopeToSdkPermissions(scope);

  // Empty tools → no MCP, regardless of scope.
  if (tools.length === 0) {
    return { ...base, mcp: [] };
  }

  // Map each tool to an MCP sub-scope; intersect with the scope's grant.
  const requested = new Set<string>();
  for (const t of tools) {
    const sub = toolToMcpScope(t);
    if (sub) requested.add(sub);
  }
  const granted = new Set(base.mcp);
  const intersection = [...requested].filter((s) => granted.has(s)).sort();

  return {
    bash: base.bash,
    fileIo: base.fileIo,
    mcp: intersection,
  };
}

function clone(p: SdkPermissions): SdkPermissions {
  return { bash: p.bash, fileIo: p.fileIo, mcp: [...p.mcp] };
}
