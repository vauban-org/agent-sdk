/**
 * Bulkhead — bound concurrent execution of an async operation.
 *
 * Sprint-468. Wrap a function so at most `maxConcurrent` invocations
 * are active at once; additional calls queue up to `maxQueued` before
 * rejecting with BulkheadFullError. Prevents a slow backend from
 * exhausting the agent's event loop or memory.
 *
 * Usage:
 *   const safeArchive = bulkhead(brain.archiveKnowledge.bind(brain), {
 *     name: "brain.archive",
 *     maxConcurrent: 5,
 *     maxQueued: 50,
 *   });
 */

export interface BulkheadOptions {
  /** Label for BulkheadFullError messages. */
  name: string;
  /** In-flight invocation cap. Default 5. */
  maxConcurrent?: number;
  /** Queue depth cap. Reject once full. Default 50. */
  maxQueued?: number;
}

export class BulkheadFullError extends Error {
  readonly bulkheadName: string;
  constructor(bulkheadName: string, queueDepth: number) {
    super(
      `Bulkhead "${bulkheadName}" full — queue depth ${queueDepth} reached.`,
    );
    this.name = "BulkheadFullError";
    this.bulkheadName = bulkheadName;
  }
}

export interface BulkheadStats {
  active: number;
  queued: number;
}

export interface Bulkhead<TArgs extends unknown[], TResult> {
  (...args: TArgs): Promise<TResult>;
  readonly stats: BulkheadStats;
}

export function bulkhead<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: BulkheadOptions,
): Bulkhead<TArgs, TResult> {
  const maxConcurrent = options.maxConcurrent ?? 5;
  const maxQueued = options.maxQueued ?? 50;

  let active = 0;
  const queue: Array<() => void> = [];

  const acquire = (): Promise<void> => {
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve();
    }
    if (queue.length >= maxQueued) {
      return Promise.reject(
        new BulkheadFullError(options.name, queue.length),
      );
    }
    return new Promise<void>((resolve) => {
      queue.push(() => {
        active += 1;
        resolve();
      });
    });
  };

  const release = (): void => {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  };

  async function run(...args: TArgs): Promise<TResult> {
    await acquire();
    try {
      return await fn(...args);
    } finally {
      release();
    }
  }

  const wrapper = run as Bulkhead<TArgs, TResult>;
  Object.defineProperty(wrapper, "stats", {
    get: () => ({ active, queued: queue.length }),
  });
  return wrapper;
}
