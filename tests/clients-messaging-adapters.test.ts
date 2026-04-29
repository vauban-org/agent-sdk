/**
 * Tests for packages/agent-sdk/src/clients/messaging-adapters.ts
 *
 * Uses mock AgentsClient and PipelinesClient — no real backend calls.
 * Sprint: command-center:sprint-524:quick-9
 */

import { describe, it, expect, vi } from "vitest";
import {
  triggerFromTelegram,
  triggerFromSlack,
  type TelegramTriggerContext,
  type SlackTriggerContext,
} from "../src/clients/messaging-adapters.js";
import type { AgentsClient } from "../src/clients/agents.js";
import type { PipelinesClient } from "../src/clients/pipelines.js";

// ─── Mock clients ─────────────────────────────────────────────────────────────

function makeAgentsMock(
  overrides: Partial<AgentsClient> = {},
): AgentsClient {
  return {
    execute: vi.fn().mockResolvedValue({
      runId: "exec-mock-123",
      runUrl: "https://command.vauban.tech/runs/exec-mock-123",
      status: "completed",
    }),
    listRegistry: vi.fn().mockResolvedValue({ agents: [] }),
    ...overrides,
  };
}

function makePipelinesMock(
  overrides: Partial<PipelinesClient> = {},
): PipelinesClient {
  return {
    run: vi.fn().mockResolvedValue({
      pipelineId: "daily-digest",
      runId: "pipe-mock-456",
      statusUrl: "https://command.vauban.tech/api/pipelines/pipe-mock-456/status",
    }),
    list: vi.fn().mockResolvedValue({ pipelines: [] }),
    status: vi.fn().mockResolvedValue({ status: "running", progress: 50 }),
    ...overrides,
  };
}

// ─── Contexts ─────────────────────────────────────────────────────────────────

const tgCtx: TelegramTriggerContext = {
  chatId: "12345678",
  from: { username: "alice" },
};

const slackCtx: SlackTriggerContext = {
  userId: "U01ABC",
  channelId: "C01DEF",
};

// ─── triggerFromTelegram ──────────────────────────────────────────────────────

describe("triggerFromTelegram", () => {
  describe("/run command", () => {
    it("calls agents.execute with correct args and returns success reply", async () => {
      const agents = makeAgentsMock();
      const pipelines = makePipelinesMock();

      const result = await triggerFromTelegram(
        agents,
        pipelines,
        tgCtx,
        "/run",
        ["ARCHITECT", "analyse", "auth", "module"],
      );

      expect(agents.execute).toHaveBeenCalledOnce();
      const call = vi.mocked(agents.execute).mock.calls[0][0];
      expect(call.agentId).toBe("ARCHITECT");
      expect(call.taskType).toBe("messaging-trigger");
      expect(call.description).toBe("analyse auth module");
      expect(call.archiveToBrain).toBe(false);

      expect(result.runId).toBe("exec-mock-123");
      expect(result.replyText).toContain("ARCHITECT");
      expect(result.replyText).toContain("exec-mock-123");
    });

    it("handles command without leading slash", async () => {
      const agents = makeAgentsMock();
      const pipelines = makePipelinesMock();
      const result = await triggerFromTelegram(
        agents,
        pipelines,
        tgCtx,
        "run",
        ["BUILDER", "build project"],
      );
      expect(agents.execute).toHaveBeenCalledOnce();
      expect(result.runId).toBe("exec-mock-123");
    });

    it("returns usage message when args are missing", async () => {
      const agents = makeAgentsMock();
      const pipelines = makePipelinesMock();
      const result = await triggerFromTelegram(
        agents,
        pipelines,
        tgCtx,
        "/run",
        [],
      );
      expect(agents.execute).not.toHaveBeenCalled();
      expect(result.replyText).toContain("Usage");
      expect(result.runId).toBeUndefined();
    });

    it("returns usage when only agentId provided (no description)", async () => {
      const agents = makeAgentsMock();
      const pipelines = makePipelinesMock();
      const result = await triggerFromTelegram(
        agents,
        pipelines,
        tgCtx,
        "/run",
        ["ARCHITECT"],
      );
      expect(agents.execute).not.toHaveBeenCalled();
      expect(result.replyText).toContain("Usage");
    });
  });

  describe("/pipeline command", () => {
    it("calls pipelines.run and returns queued reply", async () => {
      const agents = makeAgentsMock();
      const pipelines = makePipelinesMock();

      const result = await triggerFromTelegram(
        agents,
        pipelines,
        tgCtx,
        "/pipeline",
        ["daily-digest"],
      );

      expect(pipelines.run).toHaveBeenCalledOnce();
      const call = vi.mocked(pipelines.run).mock.calls[0][0];
      expect(call.name).toBe("daily-digest");

      expect(result.runId).toBe("pipe-mock-456");
      expect(result.replyText).toContain("daily-digest");
      expect(result.replyText).toContain("pipe-mock-456");
    });

    it("returns usage when pipeline name is missing", async () => {
      const agents = makeAgentsMock();
      const pipelines = makePipelinesMock();
      const result = await triggerFromTelegram(
        agents,
        pipelines,
        tgCtx,
        "/pipeline",
        [],
      );
      expect(pipelines.run).not.toHaveBeenCalled();
      expect(result.replyText).toContain("Usage");
    });
  });

  describe("/status command", () => {
    it("calls pipelines.status and returns status reply", async () => {
      const agents = makeAgentsMock();
      const pipelines = makePipelinesMock();

      const result = await triggerFromTelegram(
        agents,
        pipelines,
        tgCtx,
        "/status",
        ["run_123_abc"],
      );

      expect(pipelines.status).toHaveBeenCalledWith("run_123_abc");
      expect(result.runId).toBe("run_123_abc");
      expect(result.replyText).toContain("running");
      expect(result.replyText).toContain("50%");
    });

    it("returns usage when runId is missing", async () => {
      const agents = makeAgentsMock();
      const pipelines = makePipelinesMock();
      const result = await triggerFromTelegram(
        agents,
        pipelines,
        tgCtx,
        "/status",
        [],
      );
      expect(pipelines.status).not.toHaveBeenCalled();
      expect(result.replyText).toContain("Usage");
    });
  });

  describe("unknown command", () => {
    it("returns available commands list", async () => {
      const agents = makeAgentsMock();
      const pipelines = makePipelinesMock();
      const result = await triggerFromTelegram(
        agents,
        pipelines,
        tgCtx,
        "/help",
        [],
      );
      expect(result.replyText).toContain("Unknown command");
      expect(result.replyText).toContain("/run");
    });
  });

  describe("error handling", () => {
    it("catches execute errors and returns error reply with chatId", async () => {
      const agents = makeAgentsMock({
        execute: vi.fn().mockRejectedValue(new Error("network timeout")),
      });
      const pipelines = makePipelinesMock();

      const result = await triggerFromTelegram(
        agents,
        pipelines,
        tgCtx,
        "/run",
        ["ARCHITECT", "some task"],
      );

      expect(result.runId).toBeUndefined();
      expect(result.replyText).toContain("Error");
      expect(result.replyText).toContain("12345678");
      expect(result.replyText).toContain("network timeout");
    });
  });
});

// ─── triggerFromSlack ─────────────────────────────────────────────────────────

describe("triggerFromSlack", () => {
  describe("/run command", () => {
    it("calls agents.execute and returns success reply", async () => {
      const agents = makeAgentsMock();
      const pipelines = makePipelinesMock();

      const result = await triggerFromSlack(
        agents,
        pipelines,
        slackCtx,
        "/run",
        ["SYNERGY", "run", "competitive", "intel"],
      );

      expect(agents.execute).toHaveBeenCalledOnce();
      const call = vi.mocked(agents.execute).mock.calls[0][0];
      expect(call.agentId).toBe("SYNERGY");
      expect(call.description).toBe("run competitive intel");

      expect(result.runId).toBe("exec-mock-123");
    });
  });

  describe("/pipeline command", () => {
    it("calls pipelines.run", async () => {
      const agents = makeAgentsMock();
      const pipelines = makePipelinesMock();

      const result = await triggerFromSlack(
        agents,
        pipelines,
        slackCtx,
        "/pipeline",
        ["cairo-sentinel"],
      );

      expect(pipelines.run).toHaveBeenCalledWith({ name: "cairo-sentinel" });
      expect(result.runId).toBe("pipe-mock-456");
    });
  });

  describe("/status command", () => {
    it("calls pipelines.status", async () => {
      const agents = makeAgentsMock();
      const pipelines = makePipelinesMock();

      const result = await triggerFromSlack(
        agents,
        pipelines,
        slackCtx,
        "status",
        ["run_abc"],
      );

      expect(pipelines.status).toHaveBeenCalledWith("run_abc");
      expect(result.runId).toBe("run_abc");
    });
  });

  describe("error handling", () => {
    it("catches pipeline errors and returns error reply with userId", async () => {
      const agents = makeAgentsMock();
      const pipelines = makePipelinesMock({
        run: vi.fn().mockRejectedValue(new Error("rate limit exceeded")),
      });

      const result = await triggerFromSlack(
        agents,
        pipelines,
        slackCtx,
        "/pipeline",
        ["vault-guardian"],
      );

      expect(result.runId).toBeUndefined();
      expect(result.replyText).toContain("Error");
      expect(result.replyText).toContain("U01ABC");
      expect(result.replyText).toContain("rate limit exceeded");
    });
  });
});
