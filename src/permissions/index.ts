export type {
  ActionGate,
  ActionGateCall,
  ActionGateVerdict,
} from "./action-gate.js";
export { composeActionGates } from "./action-gate.js";
export {
  mapScopesToSdkPermissions,
  permitsCapability,
  permitsMcpScopes,
} from "./sdk-permissions.js";
export type {
  SdkCapability,
  SdkPermissions,
  FileIOMode,
  BashMode,
} from "./sdk-permissions.js";
