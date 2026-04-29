/**
 * BullMQRunner — BullMQ v5 orchestration wrapper.
 *
 * Centralises queue/worker/flow creation with per-archetype defaults,
 * Dead-Letter Queue (DLQ) handling, and OTel alerting.
 *
 * Design constraints:
 * - R2-1: BullMQ parent-failed event unreliable in multi-queue flows.
 *         Every job MUST have `attempts`, `backoff`, `removeOnFail`,
 *         AND a DLQ receiving timeouts > N minutes + OTel alert on DLQ write.
 * - R2-2: BullMQ v5 + Redis + Postgres job log (no Temporal, no Inngest).
 *
 * Archetypes:
 * - cron          — scheduled background jobs (10min timeout, 3 attempts, exp 30s)
 * - event         — reactive to Citadel events / webhooks (2min, 5 attempts, exp 5s)
 * - interactive   — human-in-the-loop tasks (60min, 1 attempt, no backoff)
 * - orchestration — parent/child DAG coordinators (30min, 2 attempts, exp 60s)
 */

import {
  type FlowChildJob,
  type FlowJob,
  FlowProducer,
  type Job,
  type JobsOptions,
  Queue,
  QueueEvents,
  type QueueEventsListener,
  type QueueOptions,
  Worker,
  type WorkerOptions,
} from "bullmq";
import IORedis, { type RedisOptions } from "ioredis";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import pino from "pino";

// Module-level logger — pino is a direct dep of this package, no CC config import.
const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

// ─── Archetypes ──────────────────────────────────────────────────────────────

export type QueueArchetype = "cron" | "event" | "interactive" | "orchestration";

interface ArchetypePolicy {
  /** Hard job timeout (ms). Jobs exceeding this → DLQ + alert. */
  timeoutMs: number;
  /** Max BullMQ attempts. */
  attempts: number;
  /** Backoff policy. `null` disables backoff entirely. */
  backoff: { type: "exponential" | "fixed"; delay: number } | null;
}

const ARCHETYPE_POLICIES: Record<QueueArchetype, ArchetypePolicy> = {
  cron: {
    timeoutMs: 10 * 60_000,
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
  },
  event: {
    timeoutMs: 2 * 60_000,
    attempts: 5,
    backoff: { type: "exponential", delay: 5_000 },
  },
  interactive: {
    timeoutMs: 60 * 60_000,
    attempts: 1,
    backoff: null,
  },
  orchestration: {
    timeoutMs: 30 * 60_000,
    attempts: 2,
    backoff: { type: "exponential", delay: 60_000 },
  },
};

// ─── Config ──────────────────────────────────────────────────────────────────

export interface BullMQRunnerConfig {
  /**
   * Redis connection URL. Example:
   *   redis://brain-prod-redis.brain-prod.svc.cluster.local:6379
   */
  redisUrl: string;
  /** Logical Redis DB index for isolation from Brain. Default 3. */
  redisDb?: number;
  /** DLQ queue name. Default "cc-dlq". */
  dlqName?: string;
  /** Default attempts if archetype policy is overridden. */
  defaultAttempts?: number;
  /** Default backoff if archetype policy is overridden. */
  defaultBackoff?: { type: "exponential" | "fixed"; delay: number };
  /** Global job timeout override (ms). Default uses archetype policy. */
  jobTimeoutMs?: number;
  /** Factory override for the Redis connection — lets tests inject a mock. */
  redisFactory?: (url: string, db: number) => IORedisLike;
}

/**
 * Minimal Redis surface exposed to BullMQ. Kept as a shared type so tests may
 * supply in-memory fakes without pulling `ioredis-mock` as a dep.
 */
export type IORedisLike = IORedis;

// ─── DLQ payload type ────────────────────────────────────────────────────────

export interface DlqJobPayload {
  originalQueue: string;
  jobId: string | undefined;
  failureReason: string;
  attemptsMade: number;
  /** Best-effort capture of the job data at time of failure (may be undefined). */
  data?: unknown;
  /** ISO timestamp when the entry was moved to DLQ. */
  movedAt: string;
}

// ─── Tracer ──────────────────────────────────────────────────────────────────

const tracer = trace.getTracer("vauban-agent-sdk.bullmq", "0.1.0");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Map an archetype policy to default BullMQ JobsOptions. */
function jobOptsFromArchetype(
  archetype: QueueArchetype,
  cfg: BullMQRunnerConfig,
): JobsOptions {
  const policy = ARCHETYPE_POLICIES[archetype];
  const attempts = cfg.defaultAttempts ?? policy.attempts;
  const backoff = cfg.defaultBackoff ?? policy.backoff ?? undefined;
  const timeoutMs = cfg.jobTimeoutMs ?? policy.timeoutMs;

  return {
    attempts,
    backoff: backoff ?? undefined,
    removeOnFail: { count: 200 },
    removeOnComplete: { count: 1000, age: 24 * 60 * 60 },
    jobId: undefined,
    // @ts-expect-error — meta is custom metadata, BullMQ ignores unknown fields.
    meta: { timeoutMs, archetype },
  };
}

// ─── Runner ──────────────────────────────────────────────────────────────────

export class BullMQRunner {
  private readonly cfg: Required<
    Pick<BullMQRunnerConfig, "redisDb" | "dlqName">
  > &
    BullMQRunnerConfig;
  private readonly connection: IORedisLike;
  private readonly sharedConnectionOpts: RedisOptions;
  private readonly queues = new Map<string, Queue>();
  private readonly queueArchetypes = new Map<string, QueueArchetype>();
  private readonly queueEvents = new Map<string, QueueEvents>();
  private readonly workers = new Set<Worker>();
  private _flow: FlowProducer | undefined;
  private _dlq: Queue<DlqJobPayload> | undefined;
  private closed = false;

  constructor(config: BullMQRunnerConfig) {
    this.cfg = {
      redisDb: 3,
      dlqName: "cc-dlq",
      ...config,
    };

    this.sharedConnectionOpts = {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      db: this.cfg.redisDb,
      lazyConnect: true,
    } satisfies RedisOptions;

    if (this.cfg.redisFactory) {
      this.connection = this.cfg.redisFactory(
        this.cfg.redisUrl,
        this.cfg.redisDb,
      );
    } else {
      this.connection = new IORedis(
        this.cfg.redisUrl,
        this.sharedConnectionOpts,
      );
    }
  }

  /**
   * Create (or return cached) a named queue bound to an archetype.
   * Repeated calls with the same name return the cached queue; the archetype
   * is validated on re-use.
   */
  createQueue(name: string, archetype: QueueArchetype): Queue {
    if (!name || typeof name !== "string") {
      throw new Error(
        "BullMQRunner.createQueue: name must be a non-empty string",
      );
    }
    const existing = this.queues.get(name);
    if (existing) {
      const priorArchetype = this.queueArchetypes.get(name);
      if (priorArchetype && priorArchetype !== archetype) {
        throw new Error(
          `BullMQRunner.createQueue: queue "${name}" already created with archetype "${priorArchetype}", refusing "${archetype}"`,
        );
      }
      return existing;
    }

    const defaultJobOptions = jobOptsFromArchetype(archetype, this.cfg);
    const queueOpts: QueueOptions = {
      connection: this.connection,
      defaultJobOptions,
    };
    const queue = new Queue(name, queueOpts);
    this.queues.set(name, queue);
    this.queueArchetypes.set(name, archetype);

    if (name !== this.cfg.dlqName) {
      this.attachDlqListener(name, archetype);
    }

    logger.info(
      {
        queue: name,
        archetype,
        timeoutMs: ARCHETYPE_POLICIES[archetype].timeoutMs,
      },
      "[bullmq] queue created",
    );
    return queue;
  }

  /**
   * Create a worker bound to a queue. The processor receives BullMQ job;
   * workers inherit the queue's archetype for lock/stall durations.
   */
  createWorker<T = unknown, R = unknown>(
    queueName: string,
    processor: (job: Job<T, R>) => Promise<R>,
    opts?: Partial<WorkerOptions>,
  ): Worker<T, R> {
    const archetype = this.queueArchetypes.get(queueName);
    if (!archetype) {
      throw new Error(
        `BullMQRunner.createWorker: queue "${queueName}" not registered — call createQueue first`,
      );
    }
    const policy = ARCHETYPE_POLICIES[archetype];
    const lockDuration = Math.max(
      30_000,
      Math.min(policy.timeoutMs, 30 * 60_000),
    );

    const workerOpts: WorkerOptions = {
      connection: this.connection,
      lockDuration,
      ...opts,
    };

    const worker = new Worker<T, R>(queueName, processor, workerOpts);
    this.workers.add(worker);

    worker.on("error", (err) => {
      logger.error({ err, queue: queueName }, "[bullmq] worker error");
    });

    logger.info(
      { queue: queueName, archetype, lockDuration },
      "[bullmq] worker started",
    );
    return worker;
  }

  /** Lazy accessor for the FlowProducer singleton. */
  flowProducer(): FlowProducer {
    if (!this._flow) {
      this._flow = new FlowProducer({ connection: this.connection });
    }
    return this._flow;
  }

  /** Lazy accessor for the DLQ. */
  dlqQueue(): Queue<DlqJobPayload> {
    if (!this._dlq) {
      this._dlq = this.createQueue(
        this.cfg.dlqName,
        "orchestration",
      ) as Queue<DlqJobPayload>;
    }
    return this._dlq;
  }

  /**
   * Parent-failed reliability helper.
   *
   * Wraps FlowProducer.add() and polls the parent job's
   * `getDependencies({ failed: true })` to explicitly mark the parent failed
   * when any child fails — guaranteeing parent.on("failed") fires even when
   * BullMQ's native propagation is flaky.
   */
  async runFlowReliable<Parent = unknown>(
    parent: {
      name: string;
      queueName: string;
      data?: Parent;
      opts?: JobsOptions;
    },
    children: Array<{
      name: string;
      queueName: string;
      data?: unknown;
      opts?: JobsOptions;
    }>,
    waitOpts: { pollIntervalMs?: number; maxWaitMs?: number } = {},
  ): Promise<{
    parentStatus: "completed" | "failed";
    failedChildren: string[];
    parentJobId: string | undefined;
  }> {
    if (children.length === 0) {
      throw new Error("runFlowReliable: children must be a non-empty array");
    }
    const flow = this.flowProducer();
    const flowJob: FlowJob = {
      name: parent.name,
      queueName: parent.queueName,
      data: parent.data as unknown as object,
      opts: parent.opts,
      children: children.map(
        (c) =>
          ({
            name: c.name,
            queueName: c.queueName,
            data: c.data as object,
            opts: c.opts,
          }) as FlowChildJob,
      ),
    };

    const tree = await flow.add(flowJob);
    const parentJobId = tree.job.id;
    const parentQueueName = parent.queueName;

    const pollMs = waitOpts.pollIntervalMs ?? 500;
    const maxWaitMs =
      waitOpts.maxWaitMs ?? ARCHETYPE_POLICIES.orchestration.timeoutMs;
    const deadline = Date.now() + maxWaitMs;

    const parentQueue = this.queues.get(parentQueueName);
    if (!parentQueue) {
      throw new Error(
        `runFlowReliable: parent queue "${parentQueueName}" not registered — call createQueue first`,
      );
    }

    while (Date.now() < deadline) {
      const parentJob = parentJobId
        ? await parentQueue.getJob(parentJobId)
        : null;
      if (!parentJob) {
        await sleep(pollMs);
        continue;
      }
      const state = await parentJob.getState();
      if (state === "completed") {
        return { parentStatus: "completed", failedChildren: [], parentJobId };
      }
      if (state === "failed") {
        const deps = await parentJob.getDependencies({
          failed: { count: 100 },
        });
        return {
          parentStatus: "failed",
          failedChildren: deps.failed ?? [],
          parentJobId,
        };
      }

      const deps = await parentJob.getDependencies({ failed: { count: 100 } });
      const failedKeys = deps.failed ?? [];
      if (failedKeys.length > 0) {
        const cause = `child_failed:${failedKeys[0]}`;
        try {
          await parentJob.moveToFailed(
            new Error(cause),
            parentJob.token ?? "0",
            false,
          );
        } catch (moveErr) {
          logger.debug(
            { err: moveErr, parentJobId },
            "[bullmq] parent moveToFailed swallowed",
          );
        }
        return {
          parentStatus: "failed",
          failedChildren: failedKeys,
          parentJobId,
        };
      }

      await sleep(pollMs);
    }

    // Hit the outer deadline — mark parent failed with timeout cause.
    const parentJob = parentJobId
      ? await parentQueue.getJob(parentJobId)
      : null;
    if (parentJob) {
      try {
        await parentJob.moveToFailed(
          new Error("parent_flow_timeout"),
          parentJob.token ?? "0",
          false,
        );
      } catch {
        // already terminal
      }
    }
    return {
      parentStatus: "failed",
      failedChildren: ["timeout"],
      parentJobId,
    };
  }

  /**
   * Build a simple queue-backed retry helper that ProviderRouter can hand
   * to its retry chain.
   */
  queueRetryFn<T>(queueName: string): (payload: T) => Promise<string> {
    const queue = this.createQueue(queueName, "event");
    return async (payload: T): Promise<string> => {
      const job = await queue.add("retry", payload as unknown as object);
      return job.id ?? "";
    };
  }

  /** Close all resources. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const closures: Array<Promise<unknown>> = [];
    for (const w of this.workers) closures.push(w.close());
    for (const q of this.queues.values()) closures.push(q.close());
    for (const qe of this.queueEvents.values()) closures.push(qe.close());
    if (this._flow) closures.push(this._flow.close());
    await Promise.allSettled(closures);

    try {
      await this.connection.quit();
    } catch {
      // ignore quit errors on forced-close paths
    }
    logger.info("[bullmq] runner closed");
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private attachDlqListener(
    queueName: string,
    archetype: QueueArchetype,
  ): void {
    const events = new QueueEvents(queueName, { connection: this.connection });
    this.queueEvents.set(queueName, events);

    const onFailed: QueueEventsListener["failed"] = async (args) => {
      try {
        const queue = this.queues.get(queueName);
        if (!queue) return;
        const job = await queue.getJob(args.jobId);
        if (!job) return;

        const policy = ARCHETYPE_POLICIES[archetype];
        const attemptsMade = job.attemptsMade ?? 0;
        const maxAttempts = job.opts.attempts ?? policy.attempts;
        const failureReason = args.failedReason ?? "unknown_failure";
        const isTimeout =
          /timeout|timed out|stalled|expired/i.test(failureReason) ||
          Boolean(
            job.processedOn && Date.now() - job.processedOn > policy.timeoutMs,
          );
        const exhausted = attemptsMade >= maxAttempts;

        if (!(exhausted || isTimeout)) {
          return;
        }

        await this.moveToDlq({
          originalQueue: queueName,
          jobId: job.id,
          failureReason,
          attemptsMade,
          data: job.data,
          movedAt: new Date().toISOString(),
        });
      } catch (err) {
        logger.error({ err, queue: queueName }, "[bullmq] DLQ routing error");
      }
    };

    events.on("failed", onFailed);
    events.on("error", (err) => {
      logger.error({ err, queue: queueName }, "[bullmq] QueueEvents error");
    });
  }

  private async moveToDlq(payload: DlqJobPayload): Promise<void> {
    const dlq = this.dlqQueue();
    await dlq.add("dlq-entry", payload, {
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    });

    const span = tracer.startSpan("agent-sdk.bullmq.dlq_write");
    try {
      span.setAttribute("cc.bullmq.queue", payload.originalQueue);
      span.setAttribute("cc.bullmq.job_id", payload.jobId ?? "unknown");
      span.setAttribute("cc.bullmq.failure_reason", payload.failureReason);
      span.setAttribute("cc.bullmq.attempts_made", payload.attemptsMade);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: payload.failureReason,
      });
    } finally {
      span.end();
    }

    logger.error(
      {
        queue: payload.originalQueue,
        jobId: payload.jobId,
        failureReason: payload.failureReason,
        attemptsMade: payload.attemptsMade,
      },
      "[bullmq] DLQ write",
    );
  }
}

// ─── Local helpers ───────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Archetype policy accessor (read-only) — exposed for tests and docs. */
export function archetypePolicy(
  archetype: QueueArchetype,
): Readonly<ArchetypePolicy> {
  return { ...ARCHETYPE_POLICIES[archetype] };
}

/** Factory — preferred over direct instantiation for testability. */
export function createBullMQRunner(config: BullMQRunnerConfig): BullMQRunner {
  return new BullMQRunner(config);
}
