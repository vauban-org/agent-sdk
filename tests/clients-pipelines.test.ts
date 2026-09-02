/**
 * Tests for packages/agent-sdk/src/clients/pipelines.ts
 *
 * The /api/pipelines/* HTTP API was removed from command-center (sprint-623) ;
 * this client is deprecated and every method must throw PipelineApiRemovedError
 * instead of attempting a network call.
 * Sprint: command-center:sprint-850:quick-7
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PipelineApiRemovedError,
  type PipelinesClientOptions,
  createPipelinesClient,
} from "../src/clients/pipelines.js";
import { _resetDeprecationWarnings } from "../src/deprecation.js";

const opts: PipelinesClientOptions = {
  baseUrl: "https://command.vauban.tech",
  getToken: async () => "pipeline-token",
};

describe("createPipelinesClient (deprecated ; API removed sprint-623)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    _resetDeprecationWarnings();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("warns once via the shared deprecation helper at construction time", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    createPipelinesClient(opts);
    createPipelinesClient(opts); // same call-site — deduped by deprecation.ts

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("createPipelinesClient");
    expect(warnSpy.mock.calls[0][0]).toContain("OODA agents scheduled via GitHub Actions");

    warnSpy.mockRestore();
  });

  it("run() throws PipelineApiRemovedError without calling fetch", async () => {
    const client = createPipelinesClient(opts);
    await expect(client.run({ name: "daily-digest" })).rejects.toBeInstanceOf(
      PipelineApiRemovedError,
    );
    await expect(client.run({ name: "daily-digest" })).rejects.toThrow(
      /PipelinesClient\.run\(\) is non-functional/,
    );
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("list() throws PipelineApiRemovedError without calling fetch", async () => {
    const client = createPipelinesClient(opts);
    await expect(client.list()).rejects.toBeInstanceOf(PipelineApiRemovedError);
    await expect(client.list()).rejects.toThrow(/PipelinesClient\.list\(\) is non-functional/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("status() throws PipelineApiRemovedError without calling fetch", async () => {
    const client = createPipelinesClient(opts);
    await expect(client.status("run_123")).rejects.toBeInstanceOf(PipelineApiRemovedError);
    await expect(client.status("run_123")).rejects.toThrow(
      /PipelinesClient\.status\(\) is non-functional/,
    );
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("error message points at the OODA/GitHub Actions replacement", async () => {
    const client = createPipelinesClient(opts);
    await expect(client.run({ name: "daily-digest" })).rejects.toThrow(
      /OODA agents scheduled via GitHub Actions/,
    );
  });

  it("error name is PipelineApiRemovedError", async () => {
    const client = createPipelinesClient(opts);
    try {
      await client.list();
      throw new Error("expected list() to throw");
    } catch (err) {
      expect((err as Error).name).toBe("PipelineApiRemovedError");
    }
  });
});
