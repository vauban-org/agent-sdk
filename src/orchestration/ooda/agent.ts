/**
 * OODAAgentImpl — sequential while+sleep cycle loop with phase persistence,
 * guards, HITL gate, resource limits, and replay-safe context propagation.
 *
 * Implements all 10 anti-patterns enforced by-design (see `./types.ts`).
 *
 * @public
 */

import { randomUUID } from "node:crypto";
import { SpanStatusCode } from "@opentelemetry/api";
import { publishEpisodicEvent } from "../../constitution/signal.js";
import { MissingDryRunFlagError } from "../../errors.js";
import type { BrainPort } from "../../ports/brain.js";
import type { LoggerPort } from "../../ports/logger.js";
import { agentSpan, getTracer } from "../../tracking/gen-ai.js";
import { EMPTY_SKILL_REGISTRY } from "./skills.js";
import type {
  CycleEvent,
  CycleStatus,
  ExecutionMode,
  OODAAgent,
  OODAAgentConfig,
  OODAContext,
  OutcomeRecord,
  PhaseDef,
  ResourceLimits,
  RiskGuard,
  SessionGuard,
  StepEvent,
} from "./types.js";
import { DEFAULT_RESOURCE_LIMITS } from "./types.js";

/**
 * Noop logger fallback when host does not inject one.
 * Prevents TypeError: Cannot read properties of undefined (0.8.1 fix).
 */
const NOOP_LOGGER = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/**
 * WM slot key for the per-run goal (sprint-895, ADR-ECO-114). Working Memory
 * is private by construction (no scope param on the port), so the goal slot
 * satisfies the `scope=private` governance requirement inherently.
 */
const RUN_GOAL_SLOT_KEY = "goal";

/** Internal sleep helper — kept private so tests grep cannot find a global setInterval. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    setTimeout(resolve, ms).unref?.();
  });
}

/**
 * Default in-memory step persister. Hosts MUST inject `insertStepImpl` /
 * `completeStepImpl` / `errorStepImpl` when persisting to Postgres.
 *
 * The default is intentionally trivial: it generates a UUID stepId and
 * a deterministic-but-fake leaf hash. This keeps the SDK runnable in
 * tests and dry-run hosts without requiring a DB.
 */
function defaultInsertStep(): OODAContext["insertStep"] {
  return async () => ({ stepId: randomUUID() });
}

function defaultCompleteStep(): OODAContext["completeStep"] {
  return async (stepId) => ({ leafHash: `0x${stepId.replace(/-/g, "")}` });
}

function defaultErrorStep(): OODAContext["errorStep"] {
  return async () => {};
}

function defaultNotifySlack(): OODAContext["notifySlack"] {
  return async () => {};
}

/**
 * Build the fire-and-forget `ctx.emitStep` helper (SDK 1.6.1).
 *
 * Wraps `insertStep → completeStep | errorStep` in an async IIFE that swallows
 * any rejection via `logger.warn`. Caller-side is synchronous and never throws.
 */
function makeEmitStep(deps: {
  readonly insertStep: OODAContext["insertStep"];
  readonly completeStep: OODAContext["completeStep"];
  readonly errorStep: OODAContext["errorStep"];
  readonly logger: LoggerPort;
}): OODAContext["emitStep"] {
  const { insertStep, completeStep, errorStep, logger } = deps;
  return (input) => {
    const status = input.status ?? "completed";
    const payload = input.payload ?? {};
    void (async () => {
      const { stepId } = await insertStep({
        type: input.type,
        phase: input.phase,
        payload,
      });
      if (status === "failed") {
        const err =
          input.error instanceof Error
            ? input.error
            : new Error(typeof input.error === "string" ? input.error : `${input.phase} failed`);
        await errorStep(stepId, err);
      } else {
        await completeStep(stepId, { ...payload, status });
      }
    })().catch((err: unknown) =>
      logger.warn(
        {
          phase: input.phase,
          status,
          err: (err as Error)?.message ?? String(err),
        },
        "[emitStep] failed",
      ),
    );
  };
}

// ─── Telemetry metadata sanitization (SDK 1.5.0 — sprint-B) ─────────────────
//
// `insertStep` callers pass arbitrary `input.payload` objects which we want to
// surface on `telemetry.step` events so the dashboard can render the real phase
// content (LLM prompt, tool output, decision body, etc.). The payload may
// contain secrets : we apply two transforms before emission.
//
//   1. PII redaction : recursively replace string values whose key matches
//      /secret|token|password|api[_-]?key/i with `"[REDACTED]"`. Bypassed when
//      `process.env.TELEMETRY_INCLUDE_PAYLOADS === "true"` (escape hatch for
//      sovereign self-hosters auditing their own runs).
//
//   2. Size cap : JSON-serialise and truncate at TELEMETRY_METADATA_MAX_BYTES
//      (4 KB). When truncated, the metadata object is replaced by a marker
//      `{ truncated: true, originalBytes }` so dashboards can flag the
//      omission rather than silently render half a payload.
//
// Side-effect free : caller's `input.payload` is never mutated.

const TELEMETRY_METADATA_MAX_BYTES = 4096;
const TELEMETRY_SENSITIVE_KEY_RE = /secret|token|password|api[_-]?key/i;

/**
 * Recursive redaction. Returns a structurally-cloned, sanitized copy.
 *
 * `seen` tracks references to detect cycles ; on a cycle we throw, which the
 * caller (`buildTelemetryMetadata`) converts to the `metadata_serialization_failed`
 * marker. We also cap depth at 32 to bound CPU on pathological nesting.
 */
const TELEMETRY_REDACT_MAX_DEPTH = 32;
function redactSensitiveKeys(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth > TELEMETRY_REDACT_MAX_DEPTH) {
    throw new Error("metadata depth exceeded");
  }
  if (seen.has(value as object)) {
    throw new Error("metadata cycle detected");
  }
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((v) => redactSensitiveKeys(v, seen, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (TELEMETRY_SENSITIVE_KEY_RE.test(k)) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = redactSensitiveKeys(v, seen, depth + 1);
    }
  }
  return out;
}

/**
 * Prepare an `insertStep` payload for emission on `telemetry.step.metadata`.
 *
 * Returns `undefined` when the payload is empty or absent — telemetry.step
 * keeps backward compat (metadata field omitted from the wire event).
 */
export function buildTelemetryMetadata(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!payload || Object.keys(payload).length === 0) return undefined;
  const includeRaw = process.env.TELEMETRY_INCLUDE_PAYLOADS === "true";
  let sanitized: Record<string, unknown>;
  try {
    sanitized = includeRaw ? payload : (redactSensitiveKeys(payload) as Record<string, unknown>);
  } catch {
    // Circular structure crashes the recursive redactor — fail closed.
    return { error: "metadata_serialization_failed" };
  }
  let json: string;
  try {
    json = JSON.stringify(sanitized);
  } catch {
    return { error: "metadata_serialization_failed" };
  }
  if (Buffer.byteLength(json, "utf8") > TELEMETRY_METADATA_MAX_BYTES) {
    return {
      truncated: true,
      originalBytes: Buffer.byteLength(json, "utf8"),
    };
  }
  return sanitized;
}

/**
 * Race a promise against an `AbortSignal.timeout`-driven rejection.
 * Anti-pattern #9 enforcement.
 */
function withPhaseTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`OODA phase timeout exceeded (${timeoutMs}ms)`));
    }, timeoutMs);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Validate phase definitions at construction time.
 * - observe + orient must be readOnly (anti-pattern #7)
 * - executionMode must be a known value (anti-pattern #6)
 */
function validateConfig(config: OODAAgentConfig): void {
  if (config.executionMode !== "dry-run" && config.executionMode !== "live") {
    throw new Error(
      `OODAAgent: executionMode is REQUIRED ('dry-run' | 'live') — got ${JSON.stringify(
        config.executionMode,
      )}`,
    );
  }
  if (config.phases.observe.readOnly !== true) {
    throw new Error("OODAAgent: phases.observe MUST be readOnly:true (anti-pattern #7)");
  }
  if (config.phases.orient.readOnly !== true) {
    throw new Error("OODAAgent: phases.orient MUST be readOnly:true (anti-pattern #7)");
  }
  if (!Number.isFinite(config.intervalMs) || config.intervalMs < 0) {
    throw new Error(`OODAAgent: intervalMs must be >= 0, got ${config.intervalMs}`);
  }
}

/**
 * OODAAgentImpl — concrete implementation. Prefer `createOODAAgent` factory.
 * @internal
 */
export class OODAAgentImpl<
  TConfig = unknown,
  TObs = unknown,
  TOrient = unknown,
  TDecision = unknown,
  TAction = unknown,
  TFeedback = unknown,
> implements OODAAgent
{
  private readonly _config: OODAAgentConfig<TConfig, TObs, TOrient, TDecision, TAction, TFeedback>;
  private readonly _limits: Required<ResourceLimits>;
  private _running = false;
  private _cyclesCompleted = 0;
  private _lastCycleAt?: string;
  private _activeCycle?: Promise<unknown>;

  constructor(config: OODAAgentConfig<TConfig, TObs, TOrient, TDecision, TAction, TFeedback>) {
    validateConfig(config as OODAAgentConfig);
    this._config = config;
    this._limits = {
      phaseTimeoutMs:
        config.resourceLimits?.phaseTimeoutMs ?? DEFAULT_RESOURCE_LIMITS.phaseTimeoutMs,
      maxStepsPerCycle:
        config.resourceLimits?.maxStepsPerCycle ?? DEFAULT_RESOURCE_LIMITS.maxStepsPerCycle,
      maxHeapMb: config.resourceLimits?.maxHeapMb ?? DEFAULT_RESOURCE_LIMITS.maxHeapMb,
    };
  }

  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;
    // Anti-pattern #1 — sequential while + sleep. NEVER setInterval.
    while (this._running) {
      this._activeCycle = this.runCycle();
      await this._activeCycle;
      this._activeCycle = undefined;
      if (!this._running) break;
      await sleep(this._config.intervalMs);
    }
  }

  async stop(): Promise<void> {
    this._running = false;
    if (this._activeCycle) {
      try {
        await this._activeCycle;
      } catch {
        // Cycle errors already surfaced via runCycle's logging.
      }
    }
  }

  async triggerCycle(opts: {
    dryRun: boolean;
    initialContext?: Record<string, unknown>;
  }): Promise<{ runId: string; status: CycleStatus }> {
    if (opts?.dryRun === undefined) {
      throw new MissingDryRunFlagError();
    }
    const overrideMode: ExecutionMode | undefined = opts.dryRun === true ? "dry-run" : undefined;
    return this.runCycle(overrideMode, opts.initialContext);
  }

  async *streamCycle(opts: {
    dryRun: boolean;
    initialContext?: Record<string, unknown>;
  }): AsyncGenerator<CycleEvent> {
    const runId = randomUUID();
    const cycleIndex = this._cyclesCompleted;
    const executionMode: ExecutionMode = opts.dryRun ? "dry-run" : this._config.executionMode;

    // ── Event channel ─────────────────────────────────────────────────────
    // We need to bridge an async-function-based execution (runCycleWithSink)
    // with an async generator consumer. We do this via a push queue + pull
    // mechanism: the sink pushes events into the queue; the generator drains
    // the queue as events arrive.
    const queue: CycleEvent[] = [];
    let done = false;
    let resolveNext: (() => void) | undefined;

    function push(evt: CycleEvent): void {
      queue.push(evt);
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = undefined;
        r();
      }
    }

    // Run the cycle body in the background; it calls push() for every event.
    const cyclePromise = this._runCycleWithSink(
      runId,
      cycleIndex,
      executionMode,
      push,
      opts.initialContext,
    ).finally(() => {
      done = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = undefined;
        r();
      }
    });

    // Drain the queue as events arrive.
    while (!done || queue.length > 0) {
      if (queue.length > 0) {
        yield queue.shift() as CycleEvent;
      } else {
        // Wait until the next push() or until done is set.
        await new Promise<void>((res) => {
          resolveNext = res;
        });
      }
    }

    // Await the cycle promise to surface any unhandled rejection.
    await cyclePromise;
  }

  getStatus(): {
    running: boolean;
    lastCycleAt?: string;
    nextCycleAt?: string;
    cyclesCompleted: number;
  } {
    return {
      running: this._running,
      lastCycleAt: this._lastCycleAt,
      cyclesCompleted: this._cyclesCompleted,
    };
  }

  // ─── internal ────────────────────────────────────────────────────────────

  private async runCycle(
    overrideMode?: ExecutionMode,
    initialContext?: Record<string, unknown>,
  ): Promise<{ runId: string; status: CycleStatus }> {
    const runId = randomUUID();
    const cycleIndex = this._cyclesCompleted;
    const executionMode = overrideMode ?? this._config.executionMode;
    const isReplay = false;
    const logger = this._config.logger ?? NOOP_LOGGER;
    const startedAt = new Date().toISOString();

    // ── Telemetry (ADR-ECO-039) ─────────────────────────────────────────────
    // Failures isolated by sink/bus — never block agent. Fire-and-forget on
    // exit paths so cycle latency is unaffected.
    const telemetry = this._config.telemetry;
    const telemetryStartFired = telemetry
      ? telemetry
          .start({
            runId,
            agentId: this._config.agentId,
            agentVersion: this._config.agentVersion ?? "0.0.0",
            model: "unknown",
            provider: "unknown",
            startedAt,
          })
          .catch((err: unknown) => {
            logger.warn({ err: (err as Error)?.message ?? String(err) }, "telemetry.start.failed");
          })
      : Promise.resolve();
    // Accumulators populated by insertStep payloads — sent in finish event.
    const telemetryTotals = {
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      costUsd: 0,
    };
    // Captures the OutcomeRecord returned by this._config.outcomeMapping so
    // finishTelemetry can propagate it on the wire event. Set late (after
    // phase chain). Sink-agnostic — the SDK never persists this itself.
    let capturedOutcome:
      | {
          type: string;
          valueCents: number;
          quality?: number;
          confidence?: number;
          metadata?: Record<string, unknown>;
        }
      | undefined;
    const finishTelemetry = (
      status: "success" | "failed" | "skipped",
      stopReason?: string,
      errorMessage?: string,
    ): void => {
      if (!telemetry) return;
      void telemetryStartFired.then(() =>
        telemetry
          .finish(runId, {
            status,
            stopReason,
            errorMessage,
            finishedAt: new Date().toISOString(),
            totalInputTokens: telemetryTotals.inputTokens,
            totalOutputTokens: telemetryTotals.outputTokens,
            totalCostUsd: telemetryTotals.costUsd,
            totalToolCalls: telemetryTotals.toolCalls,
            ...(capturedOutcome ? { outcome: capturedOutcome } : {}),
          })
          .catch((err: unknown) =>
            logger.warn({ err: (err as Error)?.message ?? String(err) }, "telemetry.finish.failed"),
          ),
      );
    };

    // ── OTel: agent-level span for the full cycle ───────────────────────────
    const tracer = getTracer("vauban-agent-sdk.ooda");
    const rootSpan = agentSpan(tracer, {
      agentId: this._config.agentId,
      agentVersion: this._config.agentVersion ?? "0.0.0",
      runId,
    });
    rootSpan.setAttribute("vauban.ooda.cycle_index", cycleIndex);
    rootSpan.setAttribute("vauban.ooda.execution_mode", executionMode);

    let stepsThisCycle = 0;
    const limits = this._limits;

    // SDK 1.6.3 — track per-step input until completion. The telemetry.step
    // event is emitted at completeStep / errorStep (not at insertStep) so
    // metadata can carry BOTH the phase input AND the phase output in a
    // single row. Map keyed by the DB stepId (returned by baseInsertStep).
    // Bound by `maxStepsPerCycle` so this never grows unboundedly.
    const inFlightSteps = new Map<
      string,
      {
        stepIndex: number;
        kind: string;
        inputPayload: Record<string, unknown>;
        startedAt: number;
      }
    >();

    const emitStepEvent = (
      tracked: {
        stepIndex: number;
        kind: string;
        inputPayload: Record<string, unknown>;
        startedAt: number;
      },
      status: "completed" | "failed",
      completionPayload: Record<string, unknown>,
    ): void => {
      if (!telemetry) return;
      const merged: Record<string, unknown> = {
        ...tracked.inputPayload,
        ...completionPayload,
      };
      const inT = Number((merged as { inputTokens?: number }).inputTokens ?? 0);
      const outT = Number((merged as { outputTokens?: number }).outputTokens ?? 0);
      const cost = Number((merged as { costUsd?: number }).costUsd ?? 0);
      const tools = Number((merged as { toolCalls?: number }).toolCalls ?? 0);
      telemetryTotals.inputTokens += inT;
      telemetryTotals.outputTokens += outT;
      telemetryTotals.costUsd += cost;
      telemetryTotals.toolCalls += tools;
      const durationMs = Math.max(0, Date.now() - tracked.startedAt);
      const metadata = buildTelemetryMetadata(merged);
      void telemetryStartFired.then(() =>
        telemetry
          .step(runId, {
            stepIndex: tracked.stepIndex,
            kind: tracked.kind,
            status,
            inputTokens: inT,
            outputTokens: outT,
            toolCalls: tools,
            costUsd: cost,
            durationMs,
            ...(metadata !== undefined ? { metadata } : {}),
          })
          .catch((err: unknown) =>
            logger.warn({ err: (err as Error)?.message ?? String(err) }, "telemetry.step.failed"),
          ),
      );
    };

    const baseInsertStep = this._config.insertStepImpl ?? defaultInsertStep();
    const insertStep: OODAContext["insertStep"] = async (input) => {
      stepsThisCycle += 1;
      if (stepsThisCycle > limits.maxStepsPerCycle) {
        throw new Error(`OODA: maxStepsPerCycle exceeded (${limits.maxStepsPerCycle})`);
      }
      const stepIndex = stepsThisCycle - 1;
      const result = await baseInsertStep(input);
      if (telemetry) {
        inFlightSteps.set(result.stepId, {
          stepIndex,
          kind: input.phase ?? input.type ?? "step",
          inputPayload: (input.payload ?? {}) as Record<string, unknown>,
          startedAt: Date.now(),
        });
      }
      return result;
    };

    const baseCompleteStep = this._config.completeStepImpl ?? defaultCompleteStep();
    const completeStep: OODAContext["completeStep"] = async (stepId, payload) => {
      const tracked = inFlightSteps.get(stepId);
      if (tracked) {
        emitStepEvent(tracked, "completed", payload);
        inFlightSteps.delete(stepId);
      }
      return baseCompleteStep(stepId, payload);
    };

    const baseErrorStep = this._config.errorStepImpl ?? defaultErrorStep();
    const errorStep: OODAContext["errorStep"] = async (stepId, err) => {
      const tracked = inFlightSteps.get(stepId);
      if (tracked) {
        emitStepEvent(tracked, "failed", {
          errorMessage: err?.message ?? String(err),
          errorName: err?.name,
        });
        inFlightSteps.delete(stepId);
      }
      return baseErrorStep(stepId, err);
    };

    let liveConfig: TConfig = (this._config.config ?? ({} as TConfig)) as TConfig;
    if (this._config.configLoader) {
      try {
        liveConfig = await this._config.configLoader.get(this._config.agentId);
      } catch (e) {
        logger.warn(
          { agentId: this._config.agentId, err: (e as Error).message },
          "ooda.cycle.config_loader_failed — using static config",
        );
      }
    }

    // completeStep + errorStep are the SDK-1.6.3-wrapped versions defined
    // above — they emit telemetry.step on completion with merged metadata.
    const ctx: OODAContext<TConfig> = Object.freeze({
      agentId: this._config.agentId,
      runId,
      cycleIndex,
      executionMode,
      isReplay,
      config: liveConfig,
      configLoader: this._config.configLoader,
      db: this._config.db,
      skills: this._config.skills ?? EMPTY_SKILL_REGISTRY,
      logger,
      deps: this._config.deps ?? {},
      insertStep,
      completeStep,
      errorStep,
      notifySlack: this._config.notifySlackImpl ?? defaultNotifySlack(),
      emitStep: makeEmitStep({ insertStep, completeStep, errorStep, logger }),
    });

    // ── Session guards ──────────────────────────────────────────────────────
    const sessionResult = await this._checkSessionGuards(this._config.sessionGuards ?? []);
    if (!sessionResult.ok) {
      logger.info(
        { runId, agentId: this._config.agentId, reason: sessionResult.reason },
        "ooda.cycle.skipped.session_guard",
      );
      rootSpan.setAttribute("vauban.ooda.status", "skipped");
      rootSpan.setAttribute("vauban.ooda.skip_reason", sessionResult.reason ?? "session_guard");
      rootSpan.setStatus({ code: SpanStatusCode.OK });
      rootSpan.end();
      this._cyclesCompleted += 1;
      this._lastCycleAt = new Date().toISOString();
      finishTelemetry("skipped", sessionResult.reason ?? "session_guard");
      return { runId, status: "skipped" };
    }

    // ── Risk guards ─────────────────────────────────────────────────────────
    const riskResult = await this._checkRiskGuards(this._config.riskGuards ?? [], ctx);
    if (!riskResult.ok) {
      logger.info(
        { runId, agentId: this._config.agentId, reason: riskResult.reason },
        "ooda.cycle.skipped.risk_guard",
      );
      rootSpan.setAttribute("vauban.ooda.status", "skipped");
      rootSpan.setAttribute("vauban.ooda.skip_reason", riskResult.reason ?? "risk_guard");
      rootSpan.setStatus({ code: SpanStatusCode.OK });
      rootSpan.end();
      this._cyclesCompleted += 1;
      this._lastCycleAt = new Date().toISOString();
      finishTelemetry("skipped", riskResult.reason ?? "risk_guard");
      return { runId, status: "skipped" };
    }

    // ── Heap watermark ──────────────────────────────────────────────────────
    const heapMb = process.memoryUsage().heapUsed / (1024 * 1024);
    if (heapMb > limits.maxHeapMb) {
      logger.warn({ runId, heapMb, limitMb: limits.maxHeapMb }, "ooda.cycle.heap_exceeded");
      rootSpan.setAttribute("vauban.ooda.status", "skipped");
      rootSpan.setAttribute("vauban.ooda.skip_reason", `heap_exceeded:${heapMb.toFixed(1)}mb`);
      rootSpan.setStatus({ code: SpanStatusCode.OK });
      rootSpan.end();
      this._cyclesCompleted += 1;
      this._lastCycleAt = new Date().toISOString();
      finishTelemetry("skipped", `heap_exceeded:${heapMb.toFixed(1)}mb`);
      return { runId, status: "skipped" };
    }

    // ── Phase chain ────────────────────────────────────────────────────────
    try {
      // Cycle start: pin the run goal into Working Memory (private plane).
      await this._setRunGoalSlot(executionMode, runId, cycleIndex, startedAt);

      // Inject initialContext into observe phase for event-driven activation
      // biome-ignore lint/suspicious/noConfusingVoidType: observe phase input type is void (empty arg).
      const observeInput: void | Record<string, unknown> = initialContext
        ? // biome-ignore lint/suspicious/noConfusingVoidType: cast empty input to the phase's void arg.
          (initialContext as unknown as void)
        : undefined;
      const obs = await this._runOodaPhase(
        this._config.phases.observe,
        observeInput,
        ctx as OODAContext,
        tracer,
      );
      // Journal the observation to Episodic Memory (PII-safe digest only).
      await this._appendEpisodic(
        executionMode,
        runId,
        "observation",
        { phase: "observe", cycleIndex, runId, digest: structuralDigest(obs) },
        0.4,
      );
      const oriented = await this._runOodaPhase(
        this._config.phases.orient,
        obs as TObs,
        ctx as OODAContext,
        tracer,
      );
      const decision = await this._runOodaPhase(
        this._config.phases.decide,
        oriented as TOrient,
        ctx as OODAContext,
        tracer,
      );
      // Journal the decision to Episodic Memory (PII-safe digest only).
      await this._appendEpisodic(
        executionMode,
        runId,
        "decision",
        { phase: "decide", cycleIndex, runId, digest: structuralDigest(decision) },
        0.7,
      );
      const action = await this._runOodaPhase(
        this._config.phases.act,
        decision as TDecision,
        ctx as OODAContext,
        tracer,
        { hitlGate: this._config.phases.act.hitlGate === true },
      );

      // Optional 6th phase — self-critique between act and feedback
      const reflectInput: TAction = action as TAction;
      const feedbackInput: TAction = this._config.phases.reflect
        ? ((await this._runOodaPhase(
            this._config.phases.reflect as PhaseDef<TAction & { decision: TDecision }, TFeedback>,
            { ...reflectInput, decision: decision as TDecision },
            ctx as OODAContext,
            tracer,
          )) as unknown as TAction)
        : (action as TAction);

      const feedback = await this._runOodaPhase(
        this._config.phases.feedback,
        feedbackInput as TAction,
        ctx as OODAContext,
        tracer,
      );

      if (this._config.outcomeMapping) {
        try {
          const outcome = this._config.outcomeMapping(feedback as TFeedback);
          if (outcome) {
            logger.info({ runId, outcome_type: outcome.outcome_type }, "ooda.cycle.outcome");
            // Propagate to telemetry.finish wire event so sinks can persist
            // it (CC sink writes agent_run.outcome_quality, OTLP exports as
            // span attributes, etc.). The SDK itself never touches storage.
            capturedOutcome = {
              type: outcome.outcome_type,
              valueCents: outcome.value_cents,
              ...(outcome.quality !== undefined ? { quality: outcome.quality } : {}),
              ...(outcome.confidence !== undefined ? { confidence: outcome.confidence } : {}),
              ...(outcome.metadata !== undefined ? { metadata: outcome.metadata } : {}),
            };
            // A verifiable conclusion → assert it as a Claim (feature-detected).
            await this._assertOutcomeClaim(runId, outcome, startedAt, executionMode);
          }
        } catch (e) {
          logger.error({ runId, err: (e as Error).message }, "ooda.cycle.outcome_mapping_failed");
        }
      }

      // ── Skill capture (Hermes Procedural Learning Loop) ─────────────────
      // Dynamic import keeps bundle cold when feature is off.
      if (this._config.skillCapture?.enabled) {
        try {
          const { captureSkillFromCycle } = await import("./skill-capture.js");
          const cycleDurationMs = Date.now() - new Date(startedAt).getTime();
          const trigger = {
            toolCallCount: stepsThisCycle,
            roi: capturedOutcome?.valueCents ? capturedOutcome.valueCents / 100 : 0,
            durationMs: cycleDurationMs,
            wasReplay: isReplay,
          };
          const traceSummary = `Cycle ${cycleIndex} ${this._config.agentId}: ${stepsThisCycle} steps`;
          const outcomeForCapture: OutcomeRecord | null = capturedOutcome
            ? {
                outcome_type: capturedOutcome.type,
                value_cents: capturedOutcome.valueCents,
                ...(capturedOutcome.quality !== undefined
                  ? { quality: capturedOutcome.quality }
                  : {}),
                ...(capturedOutcome.confidence !== undefined
                  ? { confidence: capturedOutcome.confidence }
                  : {}),
                ...(capturedOutcome.metadata !== undefined
                  ? { metadata: capturedOutcome.metadata }
                  : {}),
              }
            : null;
          await captureSkillFromCycle(
            this._config.agentId,
            runId,
            trigger,
            outcomeForCapture,
            traceSummary,
            this._config.skillCapture,
            logger,
          );
        } catch (err) {
          logger.warn({ runId, err: (err as Error).message }, "ooda.cycle.skill_capture_failed");
        }
      }

      rootSpan.setAttribute("vauban.ooda.status", "succeeded");
      rootSpan.setAttribute("vauban.ooda.steps", stepsThisCycle);
      rootSpan.setStatus({ code: SpanStatusCode.OK });
      rootSpan.end();
      this._cyclesCompleted += 1;
      this._lastCycleAt = new Date().toISOString();
      finishTelemetry("success");
      return { runId, status: "succeeded" };
    } catch (err) {
      logger.error(
        {
          runId,
          agentId: this._config.agentId,
          err: (err as Error).message,
        },
        "ooda.cycle.failed",
      );
      // Journal the failure to Episodic Memory for causal reconstruction.
      await this._appendEpisodic(
        executionMode,
        runId,
        "error",
        {
          phase: "cycle",
          cycleIndex,
          runId,
          error: (err as Error).message,
          errorName: (err as Error).name,
        },
        0.9,
      );
      rootSpan.setAttribute("vauban.ooda.status", "failed");
      rootSpan.setAttribute("vauban.ooda.steps", stepsThisCycle);
      rootSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: (err as Error).message,
      });
      rootSpan.recordException(err as Error);
      rootSpan.end();
      this._cyclesCompleted += 1;
      this._lastCycleAt = new Date().toISOString();
      finishTelemetry("failed", undefined, (err as Error).message);
      return { runId, status: "failed" };
    }
  }

  /**
   * Execute one full cycle, pushing `CycleEvent` to `sink` as they occur.
   * Used by `streamCycle()` to decouple event emission from async generator
   * mechanics. Single-pass — each phase runs exactly once.
   */
  private async _runCycleWithSink(
    runId: string,
    cycleIndex: number,
    executionMode: ExecutionMode,
    sink: (evt: CycleEvent) => void,
    _initialContext?: Record<string, unknown>,
  ): Promise<void> {
    const cycleStart = Date.now();
    const isReplay = false;
    const logger = this._config.logger ?? NOOP_LOGGER;

    // ── OTel: agent-level span for the full stream cycle ────────────────────
    const tracer = getTracer("vauban-agent-sdk.ooda");
    const rootSpan = agentSpan(tracer, {
      agentId: this._config.agentId,
      agentVersion: this._config.agentVersion ?? "0.0.0",
      runId,
    });
    rootSpan.setAttribute("vauban.ooda.cycle_index", cycleIndex);
    rootSpan.setAttribute("vauban.ooda.execution_mode", executionMode);
    rootSpan.setAttribute("vauban.ooda.stream", true);

    // Step counter — anti-pattern #9 (maxStepsPerCycle).
    let stepsThisCycle = 0;
    const limits = this._limits;

    const baseInsertStep = this._config.insertStepImpl ?? defaultInsertStep();
    const insertStep: OODAContext["insertStep"] = async (input) => {
      stepsThisCycle += 1;
      if (stepsThisCycle > limits.maxStepsPerCycle) {
        throw new Error(`OODA: maxStepsPerCycle exceeded (${limits.maxStepsPerCycle})`);
      }
      return baseInsertStep(input);
    };

    // Hot-reload config.
    let liveConfig: TConfig = (this._config.config ?? ({} as TConfig)) as TConfig;
    if (this._config.configLoader) {
      try {
        liveConfig = await this._config.configLoader.get(this._config.agentId);
      } catch (e) {
        logger.warn(
          { agentId: this._config.agentId, err: (e as Error).message },
          "ooda.stream.config_loader_failed — using static config",
        );
      }
    }

    const completeStepStream = this._config.completeStepImpl ?? defaultCompleteStep();
    const errorStepStream = this._config.errorStepImpl ?? defaultErrorStep();
    const ctx: OODAContext<TConfig> = Object.freeze({
      agentId: this._config.agentId,
      runId,
      cycleIndex,
      executionMode,
      isReplay,
      config: liveConfig,
      configLoader: this._config.configLoader,
      db: this._config.db,
      skills: this._config.skills ?? EMPTY_SKILL_REGISTRY,
      logger,
      deps: this._config.deps ?? {},
      insertStep,
      completeStep: completeStepStream,
      errorStep: errorStepStream,
      notifySlack: this._config.notifySlackImpl ?? defaultNotifySlack(),
      emitStep: makeEmitStep({
        insertStep,
        completeStep: completeStepStream,
        errorStep: errorStepStream,
        logger,
      }),
    });

    // ── Session guards ───────────────────────────────────────────────────
    const sessionResult = await this._checkSessionGuards(this._config.sessionGuards ?? []);
    if (!sessionResult.ok) {
      const reason = sessionResult.reason ?? "session_guard";
      sink({
        type: "guard_tripped",
        runId,
        cycleIndex,
        guard: "session",
        reason,
        ts: Date.now(),
      });
      sink({
        type: "cycle_skipped",
        runId,
        cycleIndex,
        reason,
        ts: Date.now(),
      });
      rootSpan.setAttribute("vauban.ooda.status", "skipped");
      rootSpan.setAttribute("vauban.ooda.skip_reason", reason);
      rootSpan.setStatus({ code: SpanStatusCode.OK });
      rootSpan.end();
      this._cyclesCompleted += 1;
      this._lastCycleAt = new Date().toISOString();
      return;
    }

    // ── Risk guards ──────────────────────────────────────────────────────
    const riskResult = await this._checkRiskGuards(this._config.riskGuards ?? [], ctx);
    if (!riskResult.ok) {
      const reason = riskResult.reason ?? "risk_guard";
      sink({
        type: "guard_tripped",
        runId,
        cycleIndex,
        guard: "risk",
        reason,
        ts: Date.now(),
      });
      sink({
        type: "cycle_skipped",
        runId,
        cycleIndex,
        reason,
        ts: Date.now(),
      });
      rootSpan.setAttribute("vauban.ooda.status", "skipped");
      rootSpan.setAttribute("vauban.ooda.skip_reason", reason);
      rootSpan.setStatus({ code: SpanStatusCode.OK });
      rootSpan.end();
      this._cyclesCompleted += 1;
      this._lastCycleAt = new Date().toISOString();
      return;
    }

    // ── Heap watermark ────────────────────────────────────────────────────
    const heapMb = process.memoryUsage().heapUsed / (1024 * 1024);
    if (heapMb > limits.maxHeapMb) {
      const reason = `heap_exceeded:${heapMb.toFixed(1)}mb`;
      sink({
        type: "guard_tripped",
        runId,
        cycleIndex,
        guard: "heap",
        reason,
        ts: Date.now(),
      });
      sink({
        type: "cycle_skipped",
        runId,
        cycleIndex,
        reason,
        ts: Date.now(),
      });
      rootSpan.setAttribute("vauban.ooda.status", "skipped");
      rootSpan.setAttribute("vauban.ooda.skip_reason", reason);
      rootSpan.setStatus({ code: SpanStatusCode.OK });
      rootSpan.end();
      this._cyclesCompleted += 1;
      this._lastCycleAt = new Date().toISOString();
      return;
    }

    // ── Phase runner (single-pass, emits events via sink) ─────────────────
    const runPhaseWithSink = async <I, O>(
      phase: PhaseDef<I, O>,
      input: I,
      phaseCtx: OODAContext,
      phaseOpts?: { hitlGate?: boolean },
    ): Promise<O> => {
      const phaseName = phase.type;
      const phaseSpan = tracer.startSpan(`ooda.phase.${phaseName}`);
      phaseSpan.setAttribute("vauban.ooda.run_id", runId);
      phaseSpan.setAttribute("vauban.ooda.phase", phaseName);

      sink({
        type: "phase_start",
        runId,
        cycleIndex,
        phase: phaseName,
        ts: Date.now(),
      });
      const phaseStart = Date.now();

      const step = await phaseCtx.insertStep({
        type: phase.type,
        phase: phaseName,
        // SDK 1.6.2 — alongside the determinism-oriented hash, surface the
        // actual phase input so dashboards can render real content. PII
        // redaction + 4 KB cap applied by buildTelemetryMetadata in the
        // insertStep wrapper, so payload may contain prompts/tool args/etc.
        payload: { input_hash: hashPayload(input), input },
      });
      phaseSpan.setAttribute("vauban.ooda.step_id", step.stepId);

      try {
        const out = await withPhaseTimeout(
          // Inject the wrapping step's id so the phase can tie a side artifact it
          // persists (e.g. an agent_decision_proof row) back to its own run_step.
          phase.fn(input, { ...phaseCtx, stepId: step.stepId }),
          this._limits.phaseTimeoutMs,
        );

        if (phaseOpts?.hitlGate === true && this._config.waitForHITL) {
          sink({
            type: "hitl_waiting",
            runId,
            cycleIndex,
            stepId: step.stepId,
            payloadHash: hashPayload(out),
            ts: Date.now(),
          });
          await this._config.waitForHITL({
            runId: phaseCtx.runId,
            stepId: step.stepId,
            payload: out,
          });
          sink({
            type: "hitl_approved",
            runId,
            cycleIndex,
            stepId: step.stepId,
            ts: Date.now(),
          });
        }

        await phaseCtx.completeStep(step.stepId, {
          // SDK 1.6.3 — surface the actual phase output alongside the
          // determinism hash, so dashboards can show what each phase
          // produced. PII redaction + 4 KB cap applied by the SDK wrapper.
          output_hash: hashPayload(out),
          output: out,
        });

        const durationMs = Date.now() - phaseStart;
        phaseSpan.setAttribute("vauban.ooda.phase_duration_ms", durationMs);
        phaseSpan.setStatus({ code: SpanStatusCode.OK });
        phaseSpan.end();

        sink({
          type: "phase_complete",
          runId,
          cycleIndex,
          phase: phaseName,
          durationMs,
          ts: Date.now(),
        });

        // Fire-and-await onStep (fail-soft — never aborts cycle).
        await this._fireOnStep({
          cycleIndex,
          runId,
          phase: phase.type,
          durationMs,
          out,
        });

        return out;
      } catch (err) {
        await phaseCtx.errorStep(step.stepId, err as Error);
        const durationMs = Date.now() - phaseStart;
        phaseSpan.setAttribute("vauban.ooda.phase_duration_ms", durationMs);
        phaseSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: (err as Error).message,
        });
        phaseSpan.recordException(err as Error);
        phaseSpan.end();

        sink({
          type: "phase_error",
          runId,
          cycleIndex,
          phase: phaseName,
          error: { message: (err as Error).message },
          ts: Date.now(),
        });
        throw err;
      }
    };

    // ── Phase chain ──────────────────────────────────────────────────────
    const startedAtIso = new Date(cycleStart).toISOString();
    try {
      // Cycle start: pin the run goal into Working Memory (private plane).
      await this._setRunGoalSlot(executionMode, runId, cycleIndex, startedAtIso);

      const obs = await runPhaseWithSink(
        this._config.phases.observe,
        // biome-ignore lint/suspicious/noConfusingVoidType: pass empty (void) input to the observe phase.
        undefined as void,
        ctx as OODAContext,
      );
      // Journal the observation to Episodic Memory (PII-safe digest only).
      await this._appendEpisodic(
        executionMode,
        runId,
        "observation",
        { phase: "observe", cycleIndex, runId, digest: structuralDigest(obs) },
        0.4,
      );
      const oriented = await runPhaseWithSink(
        this._config.phases.orient,
        obs as TObs,
        ctx as OODAContext,
      );
      const decision = await runPhaseWithSink(
        this._config.phases.decide,
        oriented as TOrient,
        ctx as OODAContext,
      );
      // Journal the decision to Episodic Memory (PII-safe digest only).
      await this._appendEpisodic(
        executionMode,
        runId,
        "decision",
        { phase: "decide", cycleIndex, runId, digest: structuralDigest(decision) },
        0.7,
      );
      const action = await runPhaseWithSink(
        this._config.phases.act,
        decision as TDecision,
        ctx as OODAContext,
        { hitlGate: this._config.phases.act.hitlGate === true },
      );

      // Optional 6th phase — self-critique between act and feedback.
      // When omitted, move directly from act → feedback.
      const reflectInput: TAction = action as TAction;
      const feedbackInput: TAction = this._config.phases.reflect
        ? ((await runPhaseWithSink(
            this._config.phases.reflect as PhaseDef<TAction & { decision: TDecision }, TFeedback>,
            { ...reflectInput, decision: decision as TDecision },
            ctx as OODAContext,
          )) as unknown as TAction)
        : (action as TAction);

      const feedback = await runPhaseWithSink(
        this._config.phases.feedback,
        feedbackInput as TAction,
        ctx as OODAContext,
      );

      // Outcome mapping (optional, non-fatal in stream mode).
      let capturedOutcome:
        | {
            type: string;
            valueCents: number;
            quality?: number;
            confidence?: number;
            metadata?: Record<string, unknown>;
          }
        | undefined;
      if (this._config.outcomeMapping) {
        try {
          const outcome = this._config.outcomeMapping(feedback as TFeedback);
          if (outcome) {
            logger.info({ runId, outcome_type: outcome.outcome_type }, "ooda.stream.outcome");
            capturedOutcome = {
              type: outcome.outcome_type,
              valueCents: outcome.value_cents,
              ...(outcome.quality !== undefined ? { quality: outcome.quality } : {}),
              ...(outcome.confidence !== undefined ? { confidence: outcome.confidence } : {}),
              ...(outcome.metadata !== undefined ? { metadata: outcome.metadata } : {}),
            };
            // A verifiable conclusion → assert it as a Claim (feature-detected).
            await this._assertOutcomeClaim(runId, outcome, startedAtIso, executionMode);
          }
        } catch (e) {
          logger.error({ runId, err: (e as Error).message }, "ooda.stream.outcome_mapping_failed");
        }
      }

      // ── Skill capture (Hermes Procedural Learning Loop, stream variant) ─
      // Symmetric to runCycle (sprint-727:stream-capture-onstep). Dynamic
      // import keeps bundle cold when the feature is off.
      if (this._config.skillCapture?.enabled) {
        try {
          const { captureSkillFromCycle } = await import("./skill-capture.js");
          const cycleDurationMs = Date.now() - cycleStart;
          const trigger = {
            toolCallCount: stepsThisCycle,
            roi: capturedOutcome?.valueCents ? capturedOutcome.valueCents / 100 : 0,
            durationMs: cycleDurationMs,
            wasReplay: isReplay,
          };
          const traceSummary = `Cycle ${cycleIndex} ${this._config.agentId} (stream): ${stepsThisCycle} steps`;
          const outcomeForCapture: OutcomeRecord | null = capturedOutcome
            ? {
                outcome_type: capturedOutcome.type,
                value_cents: capturedOutcome.valueCents,
                ...(capturedOutcome.quality !== undefined
                  ? { quality: capturedOutcome.quality }
                  : {}),
                ...(capturedOutcome.confidence !== undefined
                  ? { confidence: capturedOutcome.confidence }
                  : {}),
                ...(capturedOutcome.metadata !== undefined
                  ? { metadata: capturedOutcome.metadata }
                  : {}),
              }
            : null;
          await captureSkillFromCycle(
            this._config.agentId,
            runId,
            trigger,
            outcomeForCapture,
            traceSummary,
            this._config.skillCapture,
            logger,
          );
        } catch (err) {
          logger.warn({ runId, err: (err as Error).message }, "ooda.stream.skill_capture_failed");
        }
      }

      this._cyclesCompleted += 1;
      this._lastCycleAt = new Date().toISOString();
      rootSpan.setAttribute("vauban.ooda.status", "succeeded");
      rootSpan.setAttribute("vauban.ooda.steps", stepsThisCycle);
      rootSpan.setAttribute("vauban.ooda.duration_ms", Date.now() - cycleStart);
      rootSpan.setStatus({ code: SpanStatusCode.OK });
      rootSpan.end();
      sink({
        type: "cycle_complete",
        runId,
        cycleIndex,
        status: "succeeded",
        durationMs: Date.now() - cycleStart,
        ts: Date.now(),
      });

      // ── A4 timestamping (optional, non-blocking) ──────────────────────────
      // TODO(A-DEMO): rootHash will be provided by the Trace builder once A-DEMO
      // wires buildChain() into the cycle. Until then, no TSA call is made.
      //
      // When rootHash is available (A-DEMO integration), replace the block below:
      //
      //   if (this._config.timestamping?.when === 'on-cycle-complete') {
      //     try {
      //       await this._config.timestamping.port.request(rootHash);
      //     } catch (tsaErr) {
      //       sink({ type: 'timestamp_pending', runId, cycleIndex, rootHash, ts: Date.now() });
      //       if (this._config.timestamping.queue &&
      //           this._config.timestamping.queueHmacKeyProvider &&
      //           this._config.timestamping.queueHmacKeyId) {
      //         await this._config.timestamping.queue.enqueue(
      //           { runId, rootHash, queuedAt: Date.now() },
      //           this._config.timestamping.queueHmacKeyProvider,
      //           this._config.timestamping.queueHmacKeyId,
      //         ).catch(() => {}); // best-effort
      //       }
      //     }
      //   }
    } catch (err) {
      logger.error(
        { runId, agentId: this._config.agentId, err: (err as Error).message },
        "ooda.stream.cycle.failed",
      );
      // Journal the failure to Episodic Memory for causal reconstruction.
      await this._appendEpisodic(
        executionMode,
        runId,
        "error",
        {
          phase: "cycle",
          cycleIndex,
          runId,
          error: (err as Error).message,
          errorName: (err as Error).name,
        },
        0.9,
      );
      this._cyclesCompleted += 1;
      this._lastCycleAt = new Date().toISOString();
      rootSpan.setAttribute("vauban.ooda.status", "failed");
      rootSpan.setAttribute("vauban.ooda.steps", stepsThisCycle);
      rootSpan.setAttribute("vauban.ooda.duration_ms", Date.now() - cycleStart);
      rootSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: (err as Error).message,
      });
      rootSpan.recordException(err as Error);
      rootSpan.end();
      sink({
        type: "cycle_error",
        runId,
        cycleIndex,
        error: { message: (err as Error).message },
        ts: Date.now(),
      });
      sink({
        type: "cycle_complete",
        runId,
        cycleIndex,
        status: "failed",
        durationMs: Date.now() - cycleStart,
        ts: Date.now(),
      });
    }
  }

  /**
   * Run a single OODA phase with OTel span instrumentation. Used by runCycle().
   */
  private async _runOodaPhase<I, O>(
    phase: PhaseDef<I, O>,
    input: I,
    ctx: OODAContext,
    tracer: ReturnType<typeof getTracer>,
    opts?: { hitlGate?: boolean },
  ): Promise<O> {
    const phaseSpan = tracer.startSpan(`ooda.phase.${phase.type}`);
    phaseSpan.setAttribute("vauban.ooda.run_id", ctx.runId);
    phaseSpan.setAttribute("vauban.ooda.phase", phase.type);
    const phaseStart = Date.now();

    const step = await ctx.insertStep({
      type: phase.type,
      phase: phase.type,
      // SDK 1.6.2 — alongside the determinism-oriented hash, surface the
      // actual phase input so dashboards can render real content. PII
      // redaction + 4 KB cap applied by buildTelemetryMetadata in the
      // insertStep wrapper, so payload may contain prompts/tool args/etc.
      payload: { input_hash: hashPayload(input), input },
    });
    phaseSpan.setAttribute("vauban.ooda.step_id", step.stepId);

    try {
      const out = await withPhaseTimeout(
        // Inject the wrapping step's id (see the sibling runner above).
        phase.fn(input, { ...ctx, stepId: step.stepId }),
        this._limits.phaseTimeoutMs,
      );

      if (opts?.hitlGate === true && this._config.waitForHITL) {
        await this._config.waitForHITL({
          runId: ctx.runId,
          stepId: step.stepId,
          payload: out,
        });
      }

      // Lift LLM cost/token metadata from the phase output to the TOP LEVEL of
      // the completion payload. emitStepEvent (the telemetry-step accumulator)
      // reads costUsd/inputTokens/outputTokens/toolCalls from the merged
      // payload's top level and feeds telemetryTotals -> telemetry.finish ->
      // agent_run.cost_usd. Phases honour the documented contract by returning
      // these fields at the top level of their result; before this lift they
      // were buried under `output` and silently read as 0 (cost telemetry was
      // $0 for every OODA agent).
      const _phaseOut =
        typeof out === "object" && out !== null ? (out as Record<string, unknown>) : {};
      const _liftNum = (k: string): number | undefined => {
        const v = _phaseOut[k];
        return typeof v === "number" && Number.isFinite(v) ? v : undefined;
      };
      const _inT = _liftNum("inputTokens");
      const _outT = _liftNum("outputTokens");
      const _costUsd = _liftNum("costUsd");
      const _toolCalls = _liftNum("toolCalls");

      await ctx.completeStep(step.stepId, {
        // SDK 1.6.3 — surface the actual phase output alongside the
        // determinism hash, so dashboards can show what each phase
        // produced. PII redaction + 4 KB cap applied by the SDK wrapper.
        output_hash: hashPayload(out),
        output: out,
        // Cost/token accounting (lifted to top level for emitStepEvent).
        ...(_inT !== undefined ? { inputTokens: _inT } : {}),
        ...(_outT !== undefined ? { outputTokens: _outT } : {}),
        ...(_costUsd !== undefined ? { costUsd: _costUsd } : {}),
        ...(_toolCalls !== undefined ? { toolCalls: _toolCalls } : {}),
      });

      const durationMs = Date.now() - phaseStart;
      phaseSpan.setAttribute("vauban.ooda.phase_duration_ms", durationMs);
      phaseSpan.setStatus({ code: SpanStatusCode.OK });
      phaseSpan.end();
      // Fire-and-await onStep callback (fail-soft — never aborts cycle).
      await this._fireOnStep({
        cycleIndex: ctx.cycleIndex,
        runId: ctx.runId,
        phase: phase.type,
        durationMs,
        out,
      });
      return out;
    } catch (err) {
      await ctx.errorStep(step.stepId, err as Error);
      phaseSpan.setAttribute("vauban.ooda.phase_duration_ms", Date.now() - phaseStart);
      phaseSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: (err as Error).message,
      });
      phaseSpan.recordException(err as Error);
      phaseSpan.end();
      throw err;
    }
  }

  /**
   * Fire-soft onStep callback (sprint-727:stream-capture-onstep).
   *
   * Best-effort extraction of token/cost/model metadata from the phase output
   * shape when it looks like a standard LLM-completion result (i.e. it carries
   * `inputTokens` / `outputTokens` / `costUsd` / `model` keys). Phases that do
   * NOT return such a shape simply omit those fields — the consumer (TUI etc.)
   * must treat them as optional.
   *
   * Errors thrown by the user-provided `onStep` are caught and logged. The
   * cycle is NEVER aborted on a callback failure.
   */
  private async _fireOnStep(args: {
    cycleIndex: number;
    runId: string;
    phase: StepEvent["phase"];
    durationMs: number;
    out: unknown;
  }): Promise<void> {
    const onStep = this._config.onStep;
    if (!onStep) return;
    const logger = this._config.logger ?? NOOP_LOGGER;
    try {
      const meta = (args.out && typeof args.out === "object" ? args.out : {}) as {
        inputTokens?: unknown;
        outputTokens?: unknown;
        costUsd?: unknown;
        model?: unknown;
      };
      const tokensIn = typeof meta.inputTokens === "number" ? meta.inputTokens : undefined;
      const tokensOut = typeof meta.outputTokens === "number" ? meta.outputTokens : undefined;
      const costUsd = typeof meta.costUsd === "number" ? meta.costUsd : undefined;
      const model = typeof meta.model === "string" ? meta.model : undefined;
      const evt: StepEvent = {
        cycleIndex: args.cycleIndex,
        phase: args.phase,
        durationMs: args.durationMs,
        runId: args.runId,
        ...(tokensIn !== undefined ? { tokensIn } : {}),
        ...(tokensOut !== undefined ? { tokensOut } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(model !== undefined ? { model } : {}),
      };
      await onStep(evt);
    } catch (err) {
      logger.warn(
        {
          runId: args.runId,
          phase: args.phase,
          err: (err as Error)?.message ?? String(err),
        },
        "ooda.onstep_callback_failed",
      );
    }
  }

  // ─── V12 memory-plane wiring (sprint-895, ADR-ECO-114) ────────────────────
  //
  // All three helpers feature-detect their plane on `deps.memory` and are
  // fail-soft: a plane being absent (e.g. the Claims plane, not yet on the HTTP
  // adapter) or a write erroring NEVER aborts the cycle — it logs and returns.
  // This preserves semantic-only hosts unchanged and lets the Claims wiring
  // light up automatically once the adapter lands.

  private get _memory(): BrainPort | undefined {
    return this._config.deps?.memory;
  }

  /**
   * Set the run goal slot in Working Memory at cycle start. WM is session-
   * private by construction (no scope param), satisfying `scope=private`.
   * Dry-run cycles skip the write: memory-plane mutations are side effects,
   * and a dry-run against a real Brain would pollute shared memory.
   */
  private async _setRunGoalSlot(
    mode: ExecutionMode,
    runId: string,
    cycleIndex: number,
    startedAt: string,
  ): Promise<void> {
    if (mode === "dry-run") return;
    const working = this._memory?.working;
    if (!working) return;
    const logger = this._config.logger ?? NOOP_LOGGER;
    try {
      // Goal content is a PII-free run marker (no raw phase/host content).
      await working.set(
        runId,
        RUN_GOAL_SLOT_KEY,
        { agentId: this._config.agentId, runId, cycleIndex, startedAt },
        { importanceScore: 0.8 },
      );
    } catch (err) {
      logger.warn(
        { runId, err: (err as Error)?.message ?? String(err) },
        "ooda.cycle.wm_goal_set_failed",
      );
    }
  }

  /**
   * Append one material Episodic-Memory event via the shared signal.ts helper
   * (the single episodic-write pattern — never duplicated here). `content` MUST
   * be PII-free; callers pass a structural digest, not raw phase output.
   */
  private async _appendEpisodic(
    mode: ExecutionMode,
    runId: string,
    eventType: "observation" | "decision" | "error",
    content: Record<string, unknown>,
    importanceScore: number,
  ): Promise<void> {
    if (mode === "dry-run") return; // no memory-plane side effects in dry-run
    const memory = this._memory;
    if (!memory?.episodic) return;
    const logger = this._config.logger ?? NOOP_LOGGER;
    try {
      await publishEpisodicEvent(memory, {
        // agentId is the source_agent_id (Art.19 180-day retention floor).
        agentId: this._config.agentId,
        sessionId: runId,
        eventType,
        content,
        importanceScore,
      });
    } catch (err) {
      logger.warn(
        { runId, eventType, err: (err as Error)?.message ?? String(err) },
        "ooda.cycle.em_append_failed",
      );
    }
  }

  /**
   * Assert a verifiable conclusion to the Claims plane. Only CHECKABLE outcomes
   * become claims: a `is_pending_backfill` outcome is not yet checkable and
   * stays out of the Claims plane (it remains a hypothesis). Feature-detected —
   * skips cleanly when the Claims plane is absent.
   */
  private async _assertOutcomeClaim(
    runId: string,
    outcome: OutcomeRecord,
    startedAt: string,
    mode: ExecutionMode,
  ): Promise<void> {
    if (mode === "dry-run") return; // no memory-plane side effects in dry-run
    const claims = this._memory?.claims;
    if (!claims) return;
    if (outcome.is_pending_backfill === true) return;
    const logger = this._config.logger ?? NOOP_LOGGER;
    try {
      await claims.assert(
        `agent:${this._config.agentId}`,
        `produced-outcome:${outcome.outcome_type}`,
        String(outcome.value_cents),
        {
          confidence: outcome.confidence ?? 0.8,
          claimSource: "agent_inference",
          validFrom: startedAt,
          agentId: this._config.agentId,
          scope: "private",
        },
      );
    } catch (err) {
      logger.warn(
        { runId, err: (err as Error)?.message ?? String(err) },
        "ooda.cycle.claim_assert_failed",
      );
    }
  }

  private async _checkSessionGuards(
    guards: readonly SessionGuard[],
  ): Promise<{ ok: boolean; reason?: string }> {
    const now = new Date();
    for (const g of guards) {
      const active = await g.isActive(now);
      if (!active) return { ok: false, reason: `session:${g.name}` };
    }
    return { ok: true };
  }

  private async _checkRiskGuards(
    guards: readonly RiskGuard[],
    ctx: OODAContext,
  ): Promise<{ ok: boolean; reason?: string }> {
    for (const g of guards) {
      const r = await g.check(ctx);
      if (!r.proceed) {
        return { ok: false, reason: `risk:${g.name}:${r.reason ?? "tripped"}` };
      }
    }
    return { ok: true };
  }
}

/** Cheap structural hash — just JSON length + first chars, NOT crypto. */
function hashPayload(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    if (!s) return "null";
    return `len=${s.length}:${s.slice(0, 32)}`;
  } catch {
    return "unserializable";
  }
}

/**
 * PII-safe structural digest for Episodic-Memory event bodies — length + a
 * djb2 numeric hash, NO raw content prefix (unlike hashPayload, which surfaces
 * the first 32 chars for step dashboards). Used so EM payloads never leak raw
 * phase content per `rules/knowledge/memory-planes.md`.
 */
function structuralDigest(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? "null";
  } catch {
    return "unserializable";
  }
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0;
  }
  return `len=${s.length}:h=${h.toString(16).padStart(8, "0")}`;
}
