/**
 * Bulkhead worker pool — bounded concurrency with FIFO queue and metrics.
 *
 * Sprint-468 (command-center:sprint-468:bulkhead).
 *
 * createBulkhead returns a typed worker-pool object with:
 *   - run(fn)   — enqueue a zero-argument task; resolves/rejects per task
 *   - metrics() — live snapshot: active, queued, rejected, completed
 *
 * This is the orchestration-layer variant of resilience/bulkhead.ts.
 * The key difference is the factory pattern (one pool, many tasks) vs. the
 * resilience variant that wraps a single fixed function. Use this when the
 * pool itself is a resource to manage (e.g. DB connection pool, LLM slots).
 *
 * Queue discipline: FIFO. Tasks enter the queue in submission order and
 * acquire a worker slot in the same order.
 *
 * Fast-reject: when `rejectOnFull` is true (default) and the queue is at
 * `maxQueue` capacity, new submissions throw `BulkheadQueueFullError`
 * synchronously (before awaiting). When `rejectOnFull` is false, callers
 * block indefinitely until a slot opens — useful for back-pressure scenarios.
 * @public
 */

export class BulkheadQueueFullError extends Error {
  constructor(active: number, queued: number, maxConcurrent: number, maxQueue: number) {
    super(`Bulkhead full — active=${active}/${maxConcurrent}, queued=${queued}/${maxQueue}`);
    this.name = "BulkheadQueueFullError";
  }
}

/** @public */
export interface BulkheadOptions {
  /** Maximum number of concurrently executing tasks. */
  maxConcurrent: number;
  /** Maximum queue depth. Defaults to `maxConcurrent * 10`. */
  maxQueue?: number;
  /**
   * When true (default): reject immediately when the queue is full.
   * When false: block the caller indefinitely (unbounded wait).
   */
  rejectOnFull?: boolean;
}

/** @public */
export interface BulkheadMetrics {
  /** Currently executing task count. */
  active: number;
  /** Tasks waiting in the queue. */
  queued: number;
  /** Tasks rejected because the queue was full (lifetime counter). */
  rejected: number;
  /** Tasks that completed successfully or with an error (lifetime counter). */
  completed: number;
}

/** @public */
export interface BulkheadPool<T> {
  /**
   * Submit a zero-argument async task to the pool.
   *
   * Returns a Promise that resolves/rejects with the task's outcome.
   * May throw `BulkheadQueueFullError` synchronously when rejectOnFull=true
   * and the queue is at capacity.
   */
  run(fn: () => Promise<T>): Promise<T>;

  /** Live metrics snapshot (no allocation beyond the returned object). */
  metrics(): BulkheadMetrics;
}

/**
 * Create a typed bulkhead worker pool.
 *
 * @example
 * ```ts
 * const pool = createBulkhead<string>({ maxConcurrent: 3, maxQueue: 10 });
 * const result = await pool.run(() => fetchSomething());
 * console.log(pool.metrics()); // { active: 0, queued: 0, rejected: 0, completed: 1 }
 * ```
 * @public
 */
export function createBulkhead<T>(opts: BulkheadOptions): BulkheadPool<T> {
  const maxConcurrent = opts.maxConcurrent;
  const maxQueue = opts.maxQueue ?? maxConcurrent * 10;
  const rejectOnFull = opts.rejectOnFull !== false; // default true

  let active = 0;
  let rejected = 0;
  let completed = 0;
  const queue: Array<() => void> = [];

  function tryDequeue(): void {
    if (active >= maxConcurrent) return;
    const next = queue.shift();
    if (next) {
      active += 1;
      next();
    }
  }

  function acquire(): Promise<void> {
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve();
    }
    if (rejectOnFull && queue.length >= maxQueue) {
      rejected += 1;
      return Promise.reject(
        new BulkheadQueueFullError(active, queue.length, maxConcurrent, maxQueue),
      );
    }
    // Either not rejectOnFull, or queue has room — enqueue.
    return new Promise<void>((resolve, reject) => {
      if (queue.length >= maxQueue) {
        // Reached here only when rejectOnFull=false but queue just filled
        // concurrently before we could enqueue. Reject as safety valve.
        rejected += 1;
        reject(new BulkheadQueueFullError(active, queue.length, maxConcurrent, maxQueue));
        return;
      }
      queue.push(() => {
        resolve();
      });
    });
  }

  function release(): void {
    active -= 1;
    completed += 1;
    tryDequeue();
  }

  return {
    async run(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },

    metrics(): BulkheadMetrics {
      return { active, queued: queue.length, rejected, completed };
    },
  };
}
