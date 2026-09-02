/**
 * Tests for packages/agent-sdk/src/adapters/messaging/console.ts
 *
 * Coverage:
 *   sendAlert — writes ANSI-colored output for each level, includes title+body
 *   sendMessage — writes "[MSG→target] text", throws InvalidTargetError for empty target
 *
 * Ref: test coverage for agent-sdk/adapters/messaging/console.ts (no prior tests)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConsoleChannel } from "../src/adapters/messaging/console.js";

function mockStream() {
  const written: string[] = [];
  const stream = {
    write: vi.fn((s: string) => {
      written.push(s);
      return true;
    }),
  } as unknown as NodeJS.WriteStream;
  return { stream, written };
}

describe("ConsoleChannel", () => {
  let written: string[];
  let channel: ConsoleChannel;

  beforeEach(() => {
    const mock = mockStream();
    written = mock.written;
    channel = new ConsoleChannel({ stream: mock.stream });
  });

  // ── sendAlert ──────────────────────────────────────────────────────────────

  describe("sendAlert", () => {
    it("writes title and body to the stream", async () => {
      await channel.sendAlert("info", "Deploy complete", "All checks passed");
      expect(written[0]).toContain("Deploy complete");
      expect(written[0]).toContain("All checks passed");
    });

    it("includes [INFO] tag for info level", async () => {
      await channel.sendAlert("info", "title", "body");
      expect(written[0]).toContain("[INFO]");
    });

    it("includes [WARN] tag for warn level", async () => {
      await channel.sendAlert("warn", "title", "body");
      expect(written[0]).toContain("[WARN]");
    });

    it("includes [ERROR] tag for error level", async () => {
      await channel.sendAlert("error", "title", "body");
      expect(written[0]).toContain("[ERROR]");
    });

    it("includes [CRITICAL] tag for critical level", async () => {
      await channel.sendAlert("critical", "title", "body");
      expect(written[0]).toContain("[CRITICAL]");
    });

    it("writes ANSI cyan escape for info", async () => {
      await channel.sendAlert("info", "t", "b");
      expect(written[0]).toContain("\x1b[36m");
    });

    it("writes ANSI red escape for error", async () => {
      await channel.sendAlert("error", "t", "b");
      expect(written[0]).toContain("\x1b[31m");
    });

    it("resets ANSI color after the title", async () => {
      await channel.sendAlert("warn", "title", "body");
      expect(written[0]).toContain("\x1b[0m");
    });
  });

  // ── sendMessage ────────────────────────────────────────────────────────────

  describe("sendMessage", () => {
    it("writes [MSG→target] text to stream", async () => {
      await channel.sendMessage("alice", "hello world");
      expect(written[0]).toContain("[MSG→alice]");
      expect(written[0]).toContain("hello world");
    });

    it("trims whitespace from target", async () => {
      await channel.sendMessage("  bob  ", "hi");
      expect(written[0]).toContain("[MSG→bob]");
    });

    it("throws InvalidTargetError for empty target", async () => {
      await expect(channel.sendMessage("", "text")).rejects.toMatchObject({
        name: "InvalidTargetError",
      });
    });

    it("throws InvalidTargetError for whitespace-only target", async () => {
      await expect(channel.sendMessage("   ", "text")).rejects.toMatchObject({
        name: "InvalidTargetError",
      });
    });
  });
});
