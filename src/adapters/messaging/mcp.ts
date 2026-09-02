/**
 * MCPChannel — MessagingChannelPort adapter for MCP tool-call dispatch.
 *
 * Bridges the messaging port to any MCP server that exposes a compatible tool.
 * The adapter calls `mcpClient.callTool(toolName, args)` for both sendAlert
 * and sendMessage, delegating delivery to the MCP server implementation.
 *
 * Limitations:
 *   - Request/response only: MCP tool calls are synchronous from the caller's
 *     perspective. There is no native push or broadcast mechanism — the MCP
 *     server must handle delivery internally.
 *   - Target routing for sendMessage is forwarded as `args.target`; whether
 *     the MCP server honours it depends on the server implementation.
 *   - Errors thrown by `callTool` propagate as-is. Rate-limit handling (429
 *     or equivalent) is the responsibility of the MCP server or the caller.
 *   - No acknowledgement guarantee: if callTool resolves, the message was
 *     accepted by the MCP server but not necessarily delivered to the end
 *     recipient.
 *
 * @public
 */

import { injectTraceContext } from "../../otel/trace-context.js";
import type { AlertLevel, MessagingChannelPort } from "../../ports/messaging.js";
import { InvalidTargetError } from "../../ports/messaging.js";

/**
 * Minimal interface for an MCP client that can dispatch tool calls.
 *
 * Implementations may wrap `@modelcontextprotocol/sdk` Client or any
 * compatible transport. Only `callTool` is required.
 *
 * The optional `headers` parameter is the carrier for W3C Trace Context
 * propagation across the MCP boundary. Existing two-argument callers and
 * implementations remain valid (backward-compatible widening) ; an
 * implementation that ignores `headers` simply does not propagate the trace.
 *
 * @public
 */
export interface MCPClientLike {
  callTool(name: string, args: unknown, headers?: Record<string, string>): Promise<unknown>;
}

/**
 * Wrap an {@link MCPClientLike} so every outgoing `callTool` injects the active
 * W3C `traceparent` / `tracestate` into the call's carrier headers
 * (cross-MCP trace propagation). When there is no active span context, no
 * trace header is added and the call passes through unchanged.
 *
 * Caller-supplied headers are preserved ; the trace headers are merged in
 * (caller keys are not clobbered unless they collide with `traceparent` /
 * `tracestate`). Requires {@link registerW3CPropagator} to have run (done by
 * `initVaubanSDK`).
 *
 * @param client - The underlying MCP client to wrap.
 * @returns An MCPClientLike that injects trace headers on every call.
 * @public
 */
export function tracedMcpClient(client: MCPClientLike): MCPClientLike {
  return {
    callTool(name: string, args: unknown, headers?: Record<string, string>): Promise<unknown> {
      const carrier: Record<string, string> = { ...(headers ?? {}) };
      injectTraceContext(carrier);
      return client.callTool(name, args, carrier);
    },
  };
}

/** @public */
export interface MCPChannelConfig {
  /**
   * MCP client instance used to dispatch tool calls.
   * Must implement `callTool(name, args): Promise<unknown>`.
   */
  mcpClient: MCPClientLike;
  /**
   * Name of the MCP tool to invoke for both sendAlert and sendMessage.
   * The tool must accept `{ level, title, body }` for alerts and
   * `{ target, text }` for messages.
   */
  toolName: string;
}

/** @public */
export class MCPChannel implements MessagingChannelPort {
  readonly #client: MCPClientLike;
  readonly #toolName: string;

  constructor(config: MCPChannelConfig) {
    // Wrap so every outgoing tool call carries the active W3C traceparent
    // (cross-MCP trace propagation). No-op when no active span context.
    this.#client = tracedMcpClient(config.mcpClient);
    this.#toolName = config.toolName;
  }

  async sendAlert(level: AlertLevel, title: string, body: string): Promise<void> {
    await this.#client.callTool(this.#toolName, { level, title, body });
  }

  async sendMessage(target: string, text: string): Promise<void> {
    if (!target || target.trim() === "") {
      throw new InvalidTargetError("MCPChannel.sendMessage requires a non-empty target", target);
    }
    await this.#client.callTool(this.#toolName, {
      target: target.trim(),
      text,
    });
  }
}
