/**
 * TestChildAgentPort — In-memory ChildAgentPort for unit testing.
 *
 * Workers execute synchronously in-process. Use for agent unit tests
 * that need supervisor-worker patterns without external infrastructure.
 *
 * @public
 */

import type {
  ChildAgentOptions,
  ChildAgentPort,
  ChildAgentResult,
} from "../orchestration/ooda/child-agent.js";

export class TestChildAgentPort implements ChildAgentPort {
  private workers = new Map<
    string,
    { opts: ChildAgentOptions; status: ChildAgentResult["status"]; output?: unknown }
  >();
  private nextWorkerId = 1;
  private spyFn?: (opts: ChildAgentOptions) => Promise<unknown>;

  /**
   * Set a spy function that intercepts worker execution.
   * The spy receives the ChildAgentOptions and returns the output.
   */
  spy(fn: (opts: ChildAgentOptions) => Promise<unknown>): void {
    this.spyFn = fn;
  }

  async spawnAsync(opts: ChildAgentOptions): Promise<{ workerId: string }> {
    const workerId = `test-worker-${this.nextWorkerId++}`;
    this.workers.set(workerId, { opts, status: "accepted" });

    // Execute asynchronously (microtask)
    Promise.resolve().then(async () => {
      try {
        const output = this.spyFn ? await this.spyFn(opts) : undefined;
        this.workers.set(workerId, { opts, status: "completed", output });
      } catch {
        this.workers.set(workerId, { opts, status: "failed" });
      }
    });

    return { workerId };
  }

  async spawnSync(opts: ChildAgentOptions): Promise<ChildAgentResult> {
    const workerId = `test-worker-${this.nextWorkerId++}`;

    try {
      const output = this.spyFn ? await this.spyFn(opts) : undefined;
      this.workers.set(workerId, { opts, status: "completed", output });
      return { workerId, status: "completed", output };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.workers.set(workerId, { opts, status: "failed" });
      return { workerId, status: "failed", error };
    }
  }

  /** Get worker status. */
  getWorker(
    workerId: string,
  ): { opts: ChildAgentOptions; status: string; output?: unknown } | undefined {
    return this.workers.get(workerId);
  }

  /** Clear all state. */
  reset(): void {
    this.workers.clear();
    this.nextWorkerId = 1;
    this.spyFn = undefined;
  }
}
