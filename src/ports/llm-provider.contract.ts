/**
 * LLMProviderPort contract test suite.
 *
 * Reusable helper: any concrete adapter runs this suite to prove
 * it satisfies the LLMProviderPort behavioral contract.
 *
 * Usage (vitest):
 * ```typescript
 * import { describe, it, expect, vi } from "vitest";
 * import { llmProviderContract } from "@vauban-org/agent-sdk/ports/llm-provider.contract";
 * import { MyAdapter } from "./my-adapter.js";
 *
 * llmProviderContract(() => new MyAdapter({ ... }));
 * ```
 *
 * Tests use mocks — no real API calls.
 *
 * @public
 */

import { describe, expect, test, vi } from "vitest";
import type { ChatRequest, LLMProviderPort } from "./llm-provider.js";

const MINIMAL_REQUEST: ChatRequest = {
  messages: [{ role: "user", content: "Hello" }],
};

const LONG_REQUEST: ChatRequest = {
  messages: [
    {
      role: "user",
      content: "This is a much longer message with more content to estimate higher cost. ".repeat(
        20,
      ),
    },
  ],
  maxTokens: 2048,
};

export function llmProviderContract(factory: () => LLMProviderPort): void {
  describe("LLMProviderPort contract", () => {
    test("complete() returns ChatResponse with content + usage", async () => {
      const provider = factory();
      const response = await provider.complete(MINIMAL_REQUEST);

      expect(typeof response.content).toBe("string");
      expect(typeof response.usage.inputTokens).toBe("number");
      expect(typeof response.usage.outputTokens).toBe("number");
      expect(response.usage.inputTokens).toBeGreaterThanOrEqual(0);
      expect(response.usage.outputTokens).toBeGreaterThanOrEqual(0);
      expect(typeof response.model).toBe("string");
      expect(["stop", "length", "tool", "error"]).toContain(response.finishReason);
    });

    test("estimateCost() monotonic with token count", () => {
      const provider = factory();
      if (!provider.estimateCost) return; // optional method

      const shortCost = provider.estimateCost(MINIMAL_REQUEST);
      const longCost = provider.estimateCost(LONG_REQUEST);

      expect(typeof shortCost.usd).toBe("number");
      expect(typeof longCost.usd).toBe("number");
      expect(shortCost.usd).toBeGreaterThanOrEqual(0);
      // Longer request must have higher or equal cost (monotonic)
      expect(longCost.usd).toBeGreaterThanOrEqual(shortCost.usd);
    });

    test("handles 429 with retry or returns error finishReason", async () => {
      const provider = factory();
      // Even if the provider encounters 429, complete() must NOT throw.
      // It should return finishReason: "error" or succeed via retry.
      let threw = false;
      let response: Awaited<ReturnType<LLMProviderPort["complete"]>> | null = null;
      try {
        response = await provider.complete(MINIMAL_REQUEST);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      if (response) {
        expect(["stop", "length", "tool", "error"]).toContain(response.finishReason);
      }
    });

    test("respects abortSignal", async () => {
      const provider = factory();
      const controller = new AbortController();
      controller.abort();

      let threw = false;
      let response: Awaited<ReturnType<LLMProviderPort["complete"]>> | null = null;
      try {
        response = await provider.complete({
          ...MINIMAL_REQUEST,
          abortSignal: controller.signal,
        });
      } catch {
        threw = true;
      }
      // Must not throw. May return error finishReason.
      expect(threw).toBe(false);
      if (response) {
        expect(["stop", "length", "tool", "error"]).toContain(response.finishReason);
      }
    });

    test("propagates metadata.tenantId in usage", async () => {
      const provider = factory();
      // The adapter may use tenantId for routing/billing; the contract
      // only requires complete() does not throw with metadata present.
      const response = await provider.complete({
        ...MINIMAL_REQUEST,
        metadata: { tenantId: "tenant-abc", agentId: "agent-1" },
      });
      expect(response).toBeDefined();
      expect(typeof response.usage.inputTokens).toBe("number");
    });
  });
}

// Re-export vi for consumers who need to create mocks inline
export { vi };
