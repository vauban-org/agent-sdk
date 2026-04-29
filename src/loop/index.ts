export { AgentLoop } from "./minimal-loop.js";
export type { AgentLoopRunResult, AgentLoopConfig } from "./minimal-loop.js";

export { SdkAgentLoop } from "./sdk-loop.js";
export type {
  SdkAgentLoopConfig,
  SdkAgentLoopRunResult,
  SdkToolRegistry,
  SdkToolEntry,
  AgentToolCapabilityMarker,
} from "./sdk-loop.js";

// Unified tool contract (preferred import site).
export {
  ToolRegistryImpl,
  isValidToolName,
  zodToJsonSchema,
} from "../tools/index.js";
export type {
  AgentTool,
  MCPToolDefinition,
  ToolError,
  ToolErrorCode,
  ToolRegistry,
  ToolResult,
} from "../tools/index.js";
