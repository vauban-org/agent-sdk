/**
 * SDK permission mapping — projects vauban-auth `cc:*` scopes onto the
 * capability surface exposed to agent loops.
 *
 * Contract: scope hierarchy mirrors cc-scope-middleware.ts
 *   admin > execute > read
 *
 * Worker boot MUST call `mapScopesToSdkPermissions` once at init. Tools that
 * declare a capability absent from the derived permissions are refused at
 * dispatch time — fail-closed, never silently downgrade.
 */

/** Capability surface the SDK loop exposes to tools. */
export type SdkCapability = "bash" | "fileIO" | "web" | "mcp";

/** Severity of filesystem access granted to tools. */
export type FileIOMode = "none" | "ro" | "sandboxed";

/** Severity of shell access granted to tools. */
export type BashMode = false | "restricted";

/**
 * Runtime permission envelope. An SDK loop instance is pinned to exactly one
 * of these at construction and never mutates it.
 */
export interface SdkPermissions {
  readonly bash: BashMode;
  readonly fileIO: FileIOMode;
  readonly web: boolean;
  readonly mcp: readonly string[];
}

const EMPTY_PERMISSIONS: SdkPermissions = Object.freeze({
  bash: false as const,
  fileIO: "none" as const,
  web: false,
  mcp: Object.freeze([] as const) as readonly string[],
});

const READ_ONLY_PERMISSIONS: SdkPermissions = Object.freeze({
  bash: false as const,
  fileIO: "ro" as const,
  web: false,
  mcp: Object.freeze([
    "brain:read",
    "citadel:read",
  ] as const) as readonly string[],
});

const EXECUTE_PERMISSIONS: SdkPermissions = Object.freeze({
  bash: "restricted" as const,
  fileIO: "sandboxed" as const,
  web: false,
  mcp: Object.freeze([
    "brain:read",
    "brain:write",
    "citadel:read",
    "citadel:write",
  ] as const) as readonly string[],
});

const ADMIN_PERMISSIONS: SdkPermissions = Object.freeze({
  bash: "restricted" as const,
  fileIO: "sandboxed" as const,
  web: true,
  mcp: Object.freeze([
    "brain:read",
    "brain:write",
    "brain:admin",
    "citadel:read",
    "citadel:write",
    "citadel:admin",
  ] as const) as readonly string[],
});

/**
 * Project a JWT scope list onto SDK capabilities. Unknown scopes are ignored.
 *
 * Rules:
 * - `cc:admin` → full surface (bash restricted, fileIO sandboxed, web, mcp *)
 * - `cc:execute` → bash:restricted + fileIO:sandboxed + web:false + mcp R/W
 * - `cc:read` → bash:false + fileIO:ro + web:false + mcp R only
 * - no `cc:*` scope → fail-closed: no capabilities at all
 */
export function mapScopesToSdkPermissions(
  scopes: readonly string[],
): SdkPermissions {
  if (scopes.includes("cc:admin")) return ADMIN_PERMISSIONS;
  if (scopes.includes("cc:execute")) return EXECUTE_PERMISSIONS;
  if (scopes.includes("cc:read")) return READ_ONLY_PERMISSIONS;
  return EMPTY_PERMISSIONS;
}

/**
 * Returns true iff `permissions` authorises `capability`. Canonical gate
 * used by the SDK loop before dispatching a tool.
 */
export function permitsCapability(
  permissions: SdkPermissions,
  capability: SdkCapability,
): boolean {
  switch (capability) {
    case "bash":
      return permissions.bash !== false;
    case "fileIO":
      return permissions.fileIO !== "none";
    case "web":
      return permissions.web;
    case "mcp":
      return permissions.mcp.length > 0;
  }
}

/**
 * Returns true iff the caller holds every MCP permission in `required`.
 * Used when a tool declares a specific MCP sub-scope (e.g. "brain:write").
 */
export function permitsMcpScopes(
  permissions: SdkPermissions,
  required: readonly string[],
): boolean {
  if (required.length === 0) return true;
  return required.every((r) => permissions.mcp.includes(r));
}
