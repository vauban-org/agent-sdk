/**
 * minimal-loop — AgentLoop for multi-provider routing (Anthropic + Groq cascade).
 *
 * PUBLIC SURFACE — exactly 5 exports (1 class, 4 type re-exports). Any
 * additional helpers MUST remain unexported.
 */

import { SpanStatusCode, type Tracer } from "@opentelemetry/api";
import {
  type AgentBudgetState,
  type LogMessage,
  compactToolLogDecay,
  createCoherenceDetector,
  emergencyContextSummary,
} from "../budget/budget-state.js";
import { PromiseProgressTracker } from "../budget/promise-progress.js";
import { toApprovalRisk, type ApprovalChannel } from "../hitl/approval-channel.js";
import type { ActionGate, ActionGateVerdict } from "../permissions/action-gate.js";
import type { CapabilityGate, CapabilityGateVerdict } from "../permissions/capability-gate.js";
import type { RenewalManager } from "../permissions/renewal-manager.js";
import { makeEphemeralDelta, makeEvent } from "../remote/events.js";
import { unexecutedToolCallMarkers } from "../remote/gateway/unexecuted-tool-call.js";
import {
  isMemoryLookupTool,
  unobservedMemoryClaimWarning,
} from "../remote/gateway/unobserved-memory-claim.js";
import type { InstructionInbox } from "../remote/inbox.js";
import type { SessionEventSink } from "../remote/sink.js";
import type { VetoChannel } from "../remote/veto.js";
import type { ProviderRouter, ProviderRouterResponse } from "../router/provider-router.js";
import {
  agentSpan,
  getTracer,
  llmSpan,
  recordLlmUsage,
  recordToolResult,
  toolSpan,
} from "../tracking/gen-ai.js";
import { TextDeltaCoalescer } from "./text-delta-coalescer.js";
import { TrajectoryConfidenceTracker } from "./trajectory-confidence.js";
import { WorldStateHashTracker, canonicalStateHash, isReadOnlyTool } from "./world-state-hash.js";

// ─── ToolRegistry contract ─────────────────────────────────────────────────

// Re-export the unified contract so legacy callers of
// `import { ToolRegistry } from "@vauban-org/agent-sdk"` keep working unchanged.
export type { ToolRegistry } from "../tools/types.js";
import type { Compactor } from "../run-memory/compactor.js";
import type { RunJournalPort } from "../run-memory/types.js";
import type { AgentTool, ToolRegistry, ToolResult } from "../tools/types.js";

// ─── Types ────────────────────────────────────────────────────────────────

interface AgentLoopConfig {
  agentId: string;
  agentVersion: string;
  systemPrompt: string;
  provider: ProviderRouter;
  tools: ToolRegistry;
  budget: AgentBudgetState;
  approvalChannel?: ApprovalChannel;
  /**
   * Honest approval stop reasons (opt-in). When true, a HITL denial no longer
   * collapses onto the overloaded `user_cancelled` (the lie the child-spawn
   * `:743` note and cmd-agent's `lastHitlDenialTimedOut` workaround both fought)
   * : an explicit deny stops the loop with `approval_denied`, a fail-closed
   * timeout with `approval_timeout`, and the "no approver available at all"
   * case with `approval_denied` (fail-closed ; nobody cancelled anything). Off
   * (the default) : byte-identical to before ; a denial is reported as
   * `user_cancelled`, so cmd-chat / cmd-agent and their pinned consumers are
   * untouched until they opt in. A spawned child sets this so its outcome names
   * the real cause instead of implying the user cancelled.
   * @since sprint-1009 (child-approval-channel)
   */
  honestApprovalStops?: boolean;
  /**
   * Une approbation restée sans réponse refuse l'APPEL, plus le TOUR (opt-in).
   *
   * Le défaut historique arrête la boucle entière dès qu'une carte HITL expire.
   * En session longue, ça détruit le travail en cours : le founder a mesuré
   * (journaux 2026-08-02) trois morts de tour dans une seule session, à ~915 s
   * d'écart chacune, toutes déclenchées par un `git commit` dont la carte n'a
   * jamais été vue. Le tour mourait, le contexte était perdu, la session devait
   * être relancée à la main.
   *
   * Avec cette option, un `timeout` (personne n'a répondu) devient un refus
   * fail-closed de cet appel : l'outil n'est PAS exécuté, le refus est rendu au
   * modèle comme un résultat d'outil, et la boucle continue — exactement le
   * traitement déjà appliqué à un `action_denied` de l'ActionGate (:960). Le
   * modèle décide alors de la suite au lieu de disparaître.
   *
   * Garde : dans un même run, un outil dont l'approbation a déjà expiré n'ouvre
   * pas de seconde attente ; il est refusé sur-le-champ. Sans elle, une relance
   * du modèle coûterait un nouveau timeout plein et le remède serait pire que
   * le mal.
   *
   * Un deny EXPLICITE n'est pas concerné : l'humain a tranché, la boucle
   * s'arrête comme avant. Off (le défaut) : byte-identique.
   */
  continueOnApprovalTimeout?: boolean;
  /**
   * Notifie l'appelant qu'une approbation vient d'expirer, pour qu'il puisse la
   * rendre visible (la CLI en fait une ligne à l'écran). Best-effort et
   * non-bloquant : une exception ici n'altère jamais la décision, qui est déjà
   * prise fail-closed.
   */
  onApprovalTimeout?: (e: { toolName: string; timeoutMs: number }) => void;
  /**
   * Notifie l'appelant de l'ISSUE d'une attente d'approbation humaine
   * (`awaitApproval`), quelle qu'elle soit : approuvee, refusee, expiree, ou
   * la carte revoquee par un changement de gate en cours d'attente
   * (ADR-ECO-135 §1.3). Best-effort et non-bloquant, meme discipline que
   * {@link onApprovalTimeout} : une exception ici n'altere jamais la decision,
   * qui est deja prise. Sert a un hote (ex le collecteur de recu d'execution
   * de preste) a observer QUE l'action a transite par une approbation
   * humaine, ce que l'ActionGate seul ne peut pas voir (il decide AVANT
   * l'attente, jamais apres).
   */
  onApprovalResolved?: (e: {
    toolName: string;
    outcome: "approved" | "denied" | "timeout" | "gate_revoked";
    reason?: string;
  }) => void;
  tracker?: {
    recordStep: (d: {
      inputTokens: number;
      outputTokens: number;
      toolCalls?: number;
      costUsd: number;
    }) => Promise<void>;
  };
  /** Inject a tracer for tests. Defaults to the singleton OTel tracer. */
  tracer?: Tracer;
  /** HITL poll interval (ms). Default 500. */
  approvalPollIntervalMs?: number;
  /** HITL default timeout (ms). Default 60_000. */
  approvalTimeoutMs?: number;
  /**
   * Optional per-call approval predicate. Invoked ONLY for tools already
   * marked `dangerous`. Returning false downgrades that specific call so it
   * does NOT require human approval (e.g. a read-only `run_bash` command like
   * `which`/`date`/`ls`). Returning true — or omitting the predicate, or any
   * thrown error — keeps the dangerous tool gated (fail-closed). Lets the CLI
   * inject command-risk classification without the SDK depending on it.
   */
  approvalPredicate?: (toolCall: { name: string; args: unknown }) => boolean;
  /**
   * Optional Biscuit capability gate. When provided, every tool call is
   * checked against the gate BEFORE dispatch. Denied calls produce a
   * `tool_denied` event and a structured tool-result error; the loop
   * continues with the next call (no panic).
   */
  capabilityGate?: CapabilityGate;
  /**
   * Hook fired when the capability gate denies a tool call. Receives the
   * call name and the deny reason. Best-effort — exceptions are swallowed.
   */
  onToolDenied?: (event: {
    toolName: string;
    reason: string;
    budgetUsed: number;
  }) => void;
  /**
   * Optional pre-action governance gate, run AFTER the capability gate and
   * BEFORE dispatch on every tool call. Back it with a VerifierBattery via
   * `batteryActionGate()`, with a provable policy via `provableActionGate()`,
   * or with several gates AND-composed fail-closed via `composeActionGates()`
   * (ADR-ECO-092 preste seam: the loop sees only the {@link ActionGate}
   * interface ; the composition denies if ANY gate denies). A denied verdict
   * skips the call fail-closed, like a capability deny. Off by default ; opt-in
   * per host (zero effect when unset).
   */
  actionGate?: ActionGate;
  /** Hook fired when the action gate denies a call. Best-effort. `kind`
   * mirrors {@link ActionGateVerdict.kind} (e.g. "posture_denied"); absent
   * when the denying gate declared none. */
  onActionDenied?: (event: {
    toolName: string;
    reason: string;
    budgetUsed: number;
    kind?: string;
  }) => void;
  /**
   * Optional skill-capture completion hook (Beyond-Hermes W2-T4). Fired
   * best-effort exactly once when the loop completes cleanly
   * (stopReason === "complete"), BEFORE the run.finished event. Fail-soft: a
   * throw is swallowed and never changes the run result. The SDK only
   * NOTIFIES ; the governed write-time battery + sink live in the host (e.g.
   * preste's governedSkillCapture), so the loop stays free of host I/O. Off by
   * default (zero effect when unset). See rules/delivery/level-discipline.md.
   */
  skillCapture?: {
    onComplete: (summary: {
      runId: string;
      traceId: string;
      stopReason: "complete";
      finalMessage: string;
      stepCount: number;
    }) => void | Promise<void>;
  };
  /**
   * Coarse cost-per-call (USD). Default 0 (loop doesn't know LLM unit
   * cost). Hosts that want budget enforcement set this to a per-call
   * estimate; it accumulates across the loop and is passed to the gate.
   */
  costPerToolCallUsd?: number;
  /**
   * Optional auto-renewal. When provided, the loop calls `maybeRenew()`
   * once per LLM iteration (before tool dispatch). The manager debounces
   * and only re-issues when ≥80% of the token lifetime has elapsed.
   */
  renewalManager?: RenewalManager;
  /**
   * Number of consecutive identical tool calls that triggers a loop abort.
   * Default 6. Set higher (e.g. 12) for autonomous research agents that
   * legitimately re-visit the same tools with the same args.
   */
  loopDetectionWindow?: number;
  /**
   * Per-tool-result injection cap in characters. Unset preserves the legacy
   * hard slice at 2000 chars with no marker (byte-identical for existing
   * hosts on quota-bound providers). Hosts running large-context models
   * should derive this from the model's REAL window (preste derives it from
   * the /model/info-deduced context window — no hardcoded per-model number)
   * so a whole-file read survives injection; when a cut does happen it is
   * explicit via a self-describing `[tool result truncated: …]` marker
   * instead of a silent slice.
   */
  toolResultMaxChars?: number;
  /**
   * Steps without any tool call before a stall is declared.
   * Default 10. Set higher for agents that do long reasoning stretches.
   */
  stallThreshold?: number;
  /**
   * Optional embedding function for progress-based stall detection.
   * When provided, PromiseProgressTracker replaces the heuristic coherence check.
   * Signature: (text: string) => Promise<number[]>
   */
  embedFn?: (text: string) => Promise<number[]>;
  /**
   * Prior conversation history as proper messages (sprint-736+).
   *
   * When provided, the log is built as:
   *   [system] [initialMessages...] [user: userMessage]
   *
   * This replaces the legacy pattern of injecting history as a text suffix
   * in the system prompt. The model sees its own prior tool calls and results
   * as structured messages instead of having to parse a text summary.
   *
   * Messages with role "system" in this array are ignored — the system prompt
   * from `config.systemPrompt` is always used as the first message.
   */
  initialMessages?: Array<{ role: string; content: string; toolName?: string }>;
  /**
   * When true, disable ALL stop heuristics except budget_exhausted, complete,
   * user_cancelled, approval_denied, approval_timeout, tool_denied, and error.
   * Specifically:
   *   - WorldStateHashTracker collision → loop_definitive ; DISABLED
   *   - PromiseProgressTracker plateau → loop_definitive ; DISABLED
   *   - createCoherenceDetector loop/stall → incoherent ; DISABLED
   *
   * The read-result cache still applies (returns cached results to save tokens
   * and prevent the model from doing redundant work) but never aborts the loop.
   *
   * Use this in auto mode where the model is trusted to decide when to stop.
   * Matches Claude Code / Codex behavior: no heuristic safeguards.
   */
  disableLoopDetection?: boolean;
  /**
   * Optional cooperative cancellation signal. When the signal fires (or is
   * already aborted at run start), the loop stops cleanly at the next
   * iteration boundary or tool-dispatch boundary and returns stopReason
   * "aborted". No exception is thrown; callers receive a clean result.
   *
   * Absent (undefined) = today's behavior exactly (fully backward-compatible).
   */
  abortSignal?: AbortSignal;
  /**
   * Force a final answer before the step budget is exhausted. When true AND a
   * finite `maxSteps` is set, the loop injects ONE finalize directive on the
   * last allowed step (stepCount === maxSteps - 1): "step budget reached, do not
   * call tools, write your final answer now". This converts the common failure
   * mode of a tool-looping child — `budget_exhausted` with NO final answer —
   * into a produced (if imperfect) answer. Model-agnostic (a strong message, not
   * a provider tool-block) and strictly non-regressive: if the model ignores it
   * and calls a tool anyway, the run ends in the same `budget_exhausted` it would
   * have today. Absent/false = byte-identical to before.
   */
  forceFinalizeBeforeBudget?: boolean;
  /**
   * Wall-clock ceiling in milliseconds. 0 or undefined = unlimited.
   *
   * This is the SOTA antifragile backstop for autonomous runs: instead of an
   * arbitrary step cap (a "step" can be 100 or 50 000 tokens — unpredictable),
   * wall-clock time is semantic and predictable. When the elapsed time since
   * loop start exceeds this value, the loop stops with stopReason
   * "budget_exhausted" and loopDetail.reason "max_time".
   *
   * Recommended: interactive = unlimited (user watches), autonomous/daemon =
   * a real ceiling (e.g. 600_000 = 10 min).
   */
  maxWallClockMs?: number;
  /**
   * Cost ceiling in USD. 0 or undefined = unlimited.
   *
   * The twin of `maxWallClockMs`: a semantic, predictable budget bound for
   * autonomous runs. After each LLM round-trip the loop adds the step cost
   * (computed via `costFn`) to a running total; when it reaches `maxCostUsd`
   * the loop stops with stopReason "budget_exhausted" and
   * loopDetail.reason "max_cost".
   *
   * Requires `costFn` to be set — without a pricing function the loop cannot
   * compute cost and the ceiling is inert.
   */
  maxCostUsd?: number;
  /**
   * Pricing function: maps a step's token usage to a USD cost. Injected by
   * the caller (the SDK is pricing-table-agnostic on purpose). When set, the
   * loop accumulates cost per step and exposes the total in
   * `budgetFinal.tokensBudget` consumers / enables the `maxCostUsd` ceiling.
   */
  costFn?: (usage: { inputTokens: number; outputTokens: number }) => number;
  /**
   * Remote-control event sink. When set, the loop emits `SessionEvent`s
   * (run.start, run.step, assistant.message, tool.call.*, run.finished) so a
   * remote client can observe the run live. Default: no events emitted.
   */
  eventSink?: SessionEventSink;
  /**
   * Remote-control instruction inbox. When set, the loop drains it at every
   * step boundary and injects queued instructions into the conversation as
   * `user` messages — mid-run steering (interrupt-and-redirect).
   */
  instructionInbox?: InstructionInbox;
  /**
   * Pre-tool-call veto bus (T6a). When set together with `vetoWindowMs > 0`
   * and an `eventSink`, the loop emits `tool.intent` before every tool call
   * and waits up to `vetoWindowMs` for a matching signal. A vetoed call is
   * SKIPPED and recorded as `[vetoed by <by>]` in the conversation log so
   * the LLM can adjust on its next step.
   */
  vetoChannel?: VetoChannel;
  /**
   * Milliseconds the loop waits on `vetoChannel` per tool call before
   * proceeding. Default: 0 (veto disabled). Keep low (e.g. 1500ms) for
   * interactive supervision, higher (e.g. 10s) for fully gated runs.
   */
  vetoWindowMs?: number;
  /**
   * Grounded run memory (L1, spec 2026-07-08-grounded-loop-design.md).
   * When set: every message that enters the log during the loop is journaled
   * BEFORE any eviction (journal-first) and the compactor replaces the
   * built-in decay+emergency compaction with the non-destructive
   * window-as-cache policy. Absent = byte-identical legacy behavior.
   * @experimental
   */
  runMemory?: { journal: RunJournalPort; compactor: Compactor };
}

/** @public */
interface AgentLoopRunResult {
  finalMessage: string;
  stopReason:
    | "complete"
    | "budget_exhausted"
    | "incoherent"
    | "loop_definitive"
    | "tool_denied"
    | "user_cancelled"
    | "approval_denied"
    | "approval_timeout"
    | "error"
    | "aborted";
  budgetFinal: AgentBudgetState;
  traceId: string;
  /** Populated when stopReason === "error" — the underlying exception message. */
  errorMessage?: string;
  /**
   * Populated when stopReason === "loop_definitive". Identifies which
   * tool+args+output state was observed twice and the earlier step index.
   */
  loopDetail?: {
    toolName: string;
    hash: string;
    firstStep: number;
    repeatStep: number;
    /**
     * Sub-reason for the stop. Distinguishes WHY a budget_exhausted /
     * loop_definitive fired so callers and the CLI banner can be precise.
     */
    reason?: "max_steps" | "max_time" | "max_cost" | "hash_collision" | "progress_plateau";
  };
  /** Cumulative LLM cost in USD across the run (0 when no costFn is set). */
  costUsd?: number;
}

/**
 * Outcome of {@link AgentLoopImpl.awaitApproval}. `gate_revoked` is distinct
 * from `denied` (a human said no) and `timeout` (nobody answered): the
 * pending request was closed by a RE-CHECK of `config.actionGate` finding it
 * no longer allowed (e.g. a session posture tightened mid-wait, ADR-ECO-135
 * §1.3) — nobody was consulted, and no human refused anything. Internal to
 * this file: `awaitApproval` is a private method, not part of the 5-export
 * public surface.
 */
type ApprovalWaitOutcome =
  | { readonly outcome: "approved" | "denied" | "timeout" }
  | { readonly outcome: "gate_revoked"; readonly kind?: string; readonly reason: string };

/** @public */
class AgentLoopImpl {
  private readonly config: AgentLoopConfig;
  private readonly tracer: Tracer;

  constructor(config: AgentLoopConfig) {
    this.config = config;
    this.tracer = config.tracer ?? getTracer("vauban-agent-sdk");
  }

  /**
   * @param userMessage The actual LLM input ; appended as the final `user` log
   * entry and consumed by the model. A host that composes this from the raw
   * message plus injected envelope blocks (memory/focus/journal/priors) MUST
   * still pass that composed string here ; the model needs the envelope.
   * @param opts.displayTask What a human observer should see the run started
   * with (e.g. RUN_STARTED.task on a remote transcript). Defaults to
   * `userMessage` ; set this when `userMessage` is composed so the display
   * shows the raw request instead of the envelope's internal tags.
   * @param opts.origin Where the turn that opens this run came from. Absent
   * (the default, local turn) omits the field from RUN_STARTED — a remote
   * observer cannot currently tell a remote-queued turn from a local one ;
   * a host threading a remote-originated turn sets `"remote"` here.
   * @param opts.steerId The client-generated correlation id from the control
   * envelope that opened this run (a `message` claim's `steerId`). Absent
   * (the default) omits the field from RUN_STARTED, byte-identical to
   * before this option existed ; a host threading a remote `message` sets it
   * so a controller can resolve its own optimistic echo by identity instead
   * of by matching text (sprint-1067 t3-steerid-correlation).
   */
  async run(
    userMessage: string,
    opts?: { displayTask?: string; origin?: "local" | "remote"; steerId?: string },
  ): Promise<AgentLoopRunResult> {
    const runId = cryptoRandomId();
    const rootSpan = agentSpan(this.tracer, {
      agentId: this.config.agentId,
      agentVersion: this.config.agentVersion,
      runId,
    });
    const traceId = rootSpan.spanContext().traceId;

    // Build conversation log.
    // sprint-736+: if initialMessages provided, use them as prior conversation
    // history (proper messages) instead of injecting history as text in the
    // system prompt. This is how Claude Code / Codex work — the model sees its
    // own prior tool calls as structured messages, not as a text blob.
    const log: LogMessage[] = [
      { role: "system", content: this.config.systemPrompt },
      ...(this.config.initialMessages
        ?.filter((m) => m.role !== "system") // system is always from config
        .map((m) => ({
          role: m.role as LogMessage["role"],
          content: m.content,
          ...(m.toolName ? { toolName: m.toolName } : {}),
        })) ?? []),
      { role: "user", content: userMessage },
    ];

    // Grounded run-memory (L1): identity-tracked journal coverage. Seed
    // messages (system prompt, prior history, the task) are pre-marked: the
    // host's trajectory header/task sinks already record them and the
    // protected head is never evicted. WeakSet/WeakMap survive compaction
    // splices (object identity is stable).
    const runMemory = this.config.runMemory;
    const journalIndex = new WeakMap<LogMessage, number>();
    const journaled = new WeakSet<LogMessage>();
    for (const m of log) journaled.add(m);
    const journalNewEntries = async (skipLast: boolean): Promise<void> => {
      if (!runMemory) return;
      const end = skipLast ? log.length - 1 : log.length;
      for (let i = 0; i < end; i++) {
        const m = log[i] as LogMessage;
        if (journaled.has(m)) continue;
        journaled.add(m);
        const idx = await runMemory.journal.append(m);
        if (idx >= 0) journalIndex.set(m, idx);
      }
    };

    // Remote-control event sink — no-op safe when remote-control is off.
    const sink = this.config.eventSink;
    // C2 streaming (session-dans-la-poche, sprint-1065 t1-stream-deltas) :
    // stream a step's assistant text as EPHEMERAL coalesced deltas just
    // before its durable TEXT_MESSAGE_END, so a remote observer's cursor
    // comes alive. Guarded on `sink` FIRST so nothing (not even the
    // coalescer) is constructed off the remote path ; byte-identical when no
    // sink is wired.
    //
    // `startStepTextStream()` is called fresh at the top of EACH step (see
    // the LLM round-trip below). It hands the provider an `onDelta` it MAY
    // call live during its own network transport
    // (`ProviderRouterCompleteOptions.onDelta`), and returns `finalize` for
    // the step to call once the response resolves. Two disjoint paths,
    // chosen by whether the provider actually streamed:
    //   - >=1 real delta arrived -> the coalescer already saw the text live
    //     (the interval branch can fire mid-generation) ; `finalize` only
    //     flushes the trailing remainder, never re-pushes `content`.
    //   - zero deltas arrived (no live transport, a reasoning step, or
    //     streaming disabled/failed) -> `finalize` pushes the WHOLE content
    //     as one block, exactly the pre-streaming behavior — byte-identical.
    const startStepTextStream = (): {
      onDelta?: (chunk: string) => void;
      finalize: (content: string) => void;
    } => {
      if (!sink) return { finalize: () => {} };
      let coalescer: TextDeltaCoalescer | null = null;
      let streamed = false;
      const ensureCoalescer = (): TextDeltaCoalescer => {
        coalescer ??= new TextDeltaCoalescer({
          onFlush: (chunk) => sink.emit(makeEphemeralDelta(chunk)),
        });
        return coalescer;
      };
      return {
        onDelta: (chunk: string) => {
          if (chunk === "") return;
          streamed = true;
          ensureCoalescer().push(chunk);
        },
        finalize: (content: string) => {
          if (content === "") return;
          if (streamed) {
            ensureCoalescer().flush();
            return;
          }
          const c = ensureCoalescer();
          c.push(content);
          c.flush();
        },
      };
    };
    sink?.emit(
      makeEvent("run.start", {
        runId,
        agentId: this.config.agentId,
        agentVersion: this.config.agentVersion,
        // C5 prompt-integrity guard : raised 2000 -> 32k chars so a real task is
        // not truncated in RUN_STARTED. Still a bound (a guard, not unbounded).
        // displayTask (opts) lets a host show the raw request instead of the
        // composed prompt it actually sent the model ; absent = userMessage,
        // byte-identical to before.
        task: (opts?.displayTask ?? userMessage).slice(0, 32_000),
        startedAt: new Date().toISOString(),
        // origin (opts) : absent for a local turn, byte-identical to before.
        // A host threading a remote-originated turn sets "remote" so a
        // future observer can tell the two apart (sprint-1066 t2).
        ...(opts?.origin ? { origin: opts.origin } : {}),
        // steerId (opts) : absent unless the host threads a remote `message`
        // claim's own correlation id, byte-identical to before this option
        // existed (sprint-1067 t3-steerid-correlation).
        ...(opts?.steerId ? { steerId: opts.steerId } : {}),
      }),
    );

    const coherence = createCoherenceDetector({
      loopDetectionWindow: this.config.loopDetectionWindow,
      stallThreshold: this.config.stallThreshold,
    });
    const recentCalls: Array<{ name: string; args: unknown }> = [];
    const worldStateTracker = new WorldStateHashTracker();
    // Progress-based stall detection — replaces heuristic coherence check when
    // embedFn is provided. Tracks cosine(output, goal) delta across steps.
    // Plateau = 3+ consecutive steps with delta < 0.02 → loop correction.
    const progressTracker = this.config.embedFn
      ? new PromiseProgressTracker(userMessage, this.config.embedFn, {
          plateauEpsilon: 0.02,
          plateauWindow: 3,
        })
      : null;
    const trajectoryTracker = new TrajectoryConfidenceTracker();
    /** How many self-correction injections have been made this turn. */
    let loopCorrectionCount = 0;
    /** 1 correction injection, then stop. More corrections = model ignores them = infinite loop. */
    const MAX_LOOP_CORRECTIONS = 2;
    /**
     * Cache for read-only tool results within this turn.
     * When the model calls read_file / list_directory / run_bash (cat/ls/grep...)
     * with identical args a second time, return the cached result instead of
     * re-executing. This is transparent to the model (it gets the info it wants)
     * and avoids the WorldStateHashTracker collision → loop_definitive path.
     *
     * Cache key = "<toolName>:<canonicalJSON(args)>"
     */
    const readResultCache = new Map<string, string>();
    /**
     * Outils dont une approbation a déjà expiré dans ce run. Sous
     * `continueOnApprovalTimeout`, ils sont refusés sans rouvrir d'attente :
     * personne n'a répondu la première fois, rien ne dit qu'on répondra la
     * seconde, et chaque attente coûte le timeout plein.
     */
    const approvalTimedOutTools = new Set<string>();
    let stepsWithoutTool = 0;
    // Reprises accordees a un modele qui ECRIT un appel d'outil au lieu de
    // l'emettre. Bornees a une : au-dela, on laisse passer et l'annotation du
    // rendu prend le relais. Une boucle qui insiste sans fin serait pire que
    // le defaut qu'elle corrige.
    let narratedToolCallNudges = 0;
    // Une recherche en memoire a-t-elle REELLEMENT tourne dans ce run ? Seule la
    // boucle le sait ; le rendu ne voit que du texte, et un texte ne dit pas ce
    // qu'il a fait. Sert a refuser un verdict d'absence non observe.
    let memoryLookupRan = false;
    // Meme borne que ci-dessus, et pour la meme raison.
    let unobservedMemoryNudges = 0;
    let stopReason: AgentLoopRunResult["stopReason"] = "complete";
    let finalMessage = "";
    let loopDetail: AgentLoopRunResult["loopDetail"];
    /** Cumulative tool-call cost across the loop (USD), for the gate. */
    let budgetUsedUsd = 0;
    /** Cumulative LLM token cost (USD) — for the maxCostUsd ceiling. */
    let cumulativeCostUsd = 0;
    /** Wall-clock loop start — for the maxWallClockMs antifragile backstop. */
    const loopStartMs = Date.now();

    try {
      while (true) {
        // Remote-control: drain injected instructions at the step boundary —
        // interrupt-and-redirect. Each becomes a `user` steering message in
        // the log; the model sees it on the next round-trip.
        if (this.config.instructionInbox) {
          for (const instr of this.config.instructionInbox.drain()) {
            log.push({
              role: "user",
              content: instr.whisper
                ? `[steering hint — not a task change] ${instr.text}`
                : instr.text,
            });
            sink?.emit(
              makeEvent("instruction.injected", {
                text: instr.text,
                source: instr.source,
                whisper: instr.whisper,
                // steerId : threaded from the queued Instruction when its
                // producer supplied one (a `steer`/`whisper` claim), absent
                // otherwise ; byte-identical to before this field existed
                // (sprint-1067 t3-steerid-correlation).
                ...(instr.steerId ? { steerId: instr.steerId } : {}),
              }),
            );
          }
        }

        // Cooperative cancellation ; check at the top of every iteration,
        // before any provider call. Returns cleanly (no throw).
        if (this.config.abortSignal?.aborted) {
          stopReason = "aborted";
          break;
        }

        // maxSteps === 0 means unlimited (used with permissionLevel "auto").
        if (
          this.config.budget.maxSteps > 0 &&
          this.config.budget.stepCount >= this.config.budget.maxSteps
        ) {
          stopReason = "budget_exhausted";
          loopDetail = {
            toolName: "",
            hash: "max_steps",
            firstStep: 0,
            repeatStep: this.config.budget.stepCount,
            reason: "max_steps",
          };
          break;
        }

        // Wall-clock backstop — the SOTA antifragile bound for autonomous
        // runs. Unlike maxSteps (arbitrary), elapsed time is semantic and
        // predictable. 0/undefined = unlimited (interactive mode).
        if (
          this.config.maxWallClockMs !== undefined &&
          this.config.maxWallClockMs > 0 &&
          Date.now() - loopStartMs >= this.config.maxWallClockMs
        ) {
          stopReason = "budget_exhausted";
          loopDetail = {
            toolName: "",
            hash: "max_time",
            firstStep: 0,
            repeatStep: this.config.budget.stepCount,
            reason: "max_time",
          };
          rootSpan.addEvent("gen_ai.agent.max_time", {
            elapsed_ms: Date.now() - loopStartMs,
            limit_ms: this.config.maxWallClockMs,
          });
          break;
        }

        // Cost backstop — twin of the wall-clock bound. Stops the run once
        // accumulated LLM cost reaches the ceiling. Inert without costFn.
        if (
          this.config.maxCostUsd !== undefined &&
          this.config.maxCostUsd > 0 &&
          cumulativeCostUsd >= this.config.maxCostUsd
        ) {
          stopReason = "budget_exhausted";
          loopDetail = {
            toolName: "",
            hash: "max_cost",
            firstStep: 0,
            repeatStep: this.config.budget.stepCount,
            reason: "max_cost",
          };
          rootSpan.addEvent("gen_ai.agent.max_cost", {
            cost_usd: cumulativeCostUsd,
            limit_usd: this.config.maxCostUsd,
          });
          break;
        }

        // Auto-renewal: best-effort, debounced inside the manager. A
        // failed renewal is non-fatal — the existing token may still be
        // valid; the gate will deny on the next call if it expired.
        if (this.config.renewalManager) {
          try {
            await this.config.renewalManager.maybeRenew();
          } catch {
            /* swallow — verifier will surface expiry on next call */
          }
        }

        // Grounded run-memory (L1): journal-first scan of every message that
        // entered the log since the previous iteration, THEN the
        // non-destructive compactor. Legacy decay+emergency path preserved
        // byte-identical when runMemory is absent.
        await journalNewEntries(false);
        const { contextWindow } = this.config.budget;
        if (runMemory) {
          const outcome = await runMemory.compactor.maybeCompact(
            log,
            this.config.budget,
            async (prompt) => {
              const res = await this.config.provider.complete({
                messages: [{ role: "user", content: prompt }],
                maxTokens: 1024,
              });
              return res.content;
            },
            (m) => journalIndex.get(m),
          );
          if (outcome.compacted) {
            log.splice(0, log.length, ...outcome.log);
            rootSpan.addEvent("gen_ai.agent.grounded_compaction", {
              mode: outcome.mode,
              tokens_after: contextWindow.currentTokens,
            });
          }
        } else {
          // Compaction trigger.
          if (
            this.config.budget.stepCount > 0 &&
            this.config.budget.stepCount === this.config.budget.compactionTrigger
          ) {
            const before = this.config.budget.contextWindow.currentTokens;
            // Ebbinghaus decay-based compaction — keeps high-value steps, evicts stale ones.
            const compacted = compactToolLogDecay(log, {
              halfLifeTurns: 8,
              errorBonus: 0.3,
              keepTopK: 30,
            });
            log.splice(0, log.length, ...compacted);
            rootSpan.addEvent("gen_ai.agent.compacted", {
              before_tokens: before,
              after_tokens: this.config.budget.contextWindow.currentTokens,
            });
          }

          // Emergency summary if context > 90% of max.
          if (
            contextWindow.maxTokens > 0 &&
            contextWindow.currentTokens > Math.floor(contextWindow.maxTokens * 0.9)
          ) {
            try {
              const summary = await emergencyContextSummary(
                log,
                async (prompt) => {
                  const res = await this.config.provider.complete({
                    messages: [{ role: "user", content: prompt }],
                    maxTokens: 1024,
                  });
                  return res.content;
                },
                { recursion: false },
              );
              // NEVER wipe the anchors (sprint-936 chat-wipe bug): losing the
              // system prompt and the user's task made the model restart from
              // scratch mid-turn ("fresh start, I don't see prior context"),
              // re-explore, re-cross the threshold, and loop. Keep
              // [system, first user task, recap]; evict everything else.
              const systemMsg = log[0]?.role === "system" ? log[0] : undefined;
              const firstUser = log.find((m) => m.role === "user");
              log.splice(
                0,
                log.length,
                ...(systemMsg ? [systemMsg] : []),
                ...(firstUser ? [firstUser] : []),
                {
                  role: "system",
                  content: `[context recap] ${summary}`,
                },
              );
              contextWindow.currentTokens = log.reduce((t, m) => t + estimateTokens(m.content), 0);
              rootSpan.addEvent("gen_ai.agent.emergency_summary", {
                tokens_after: contextWindow.currentTokens,
              });
            } catch (err) {
              rootSpan.addEvent("gen_ai.agent.emergency_summary_failed", {
                error: (err as Error)?.message ?? String(err),
              });
            }
          }
        }

        // ─── Force-finalize on the last allowed step ────────────────────
        // Opt-in (forceFinalizeBeforeBudget). On the final step the model would
        // otherwise spend on yet another tool call and then hit the budget with
        // no answer (the tool-looping-child failure mode). Inject ONE strong
        // directive so the model writes its answer NOW. Strictly non-regressive:
        // if it calls a tool anyway, the next iteration hits the budget exactly
        // as today. Fires exactly once (this body runs once at stepCount==max-1).
        if (
          this.config.forceFinalizeBeforeBudget === true &&
          this.config.budget.maxSteps > 0 &&
          this.config.budget.stepCount === this.config.budget.maxSteps - 1
        ) {
          log.push({
            role: "user",
            content:
              "⚠️ STEP BUDGET REACHED — this is your FINAL step. Do NOT call any " +
              "tool. Using only the information you have already gathered, write " +
              "your complete final answer now. If the information is incomplete, " +
              "state what you found and what is missing, but produce an answer.",
          });
          sink?.emit(
            makeEvent("instruction.injected", {
              text: "force-finalize (step budget reached)",
              source: "loop",
              whisper: true,
            }),
          );
        }

        // ─── LLM round-trip ─────────────────────────────────────────────
        const lSpan = llmSpan(this.tracer, {
          provider: "router",
          model: "auto",
          maxTokens: this.config.budget.tokensBudget.output,
          messageCount: log.length,
        });
        // Fresh per step — see the `startStepTextStream` doc-comment above.
        const stepTextStream = startStepTextStream();
        let response: ProviderRouterResponse;
        try {
          response = await this.config.provider.complete(
            {
              messages: log.map((m) => ({
                role: m.role,
                content: m.content,
                ...(m.toolName ? { toolName: m.toolName } : {}),
              })),
              maxTokens: this.config.budget.tokensBudget.output,
            },
            stepTextStream.onDelta ? { onDelta: stepTextStream.onDelta } : undefined,
          );
          recordLlmUsage(lSpan, {
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            latencyMs: response.latencyMs,
            finishReason: response.toolCalls.length > 0 ? "tool_use" : "stop",
          });
          lSpan.setAttribute("gen_ai.system", response.provider);
          lSpan.setStatus({ code: SpanStatusCode.OK });
        } catch (err) {
          lSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: (err as Error)?.message,
          });
          lSpan.recordException(err as Error);
          lSpan.end();
          throw err;
        } finally {
          if (lSpan.isRecording()) lSpan.end();
        }

        // Counters.
        this.config.budget.stepCount += 1;
        this.config.budget.tokensBudget.usedInput += response.usage.inputTokens;
        this.config.budget.tokensBudget.usedOutput += response.usage.outputTokens;
        // True window occupancy, not a running sum: the prompt of step N
        // already re-sends the whole prefix (system + history + prior steps),
        // so ADDING each step's inputTokens double-counts quadratically. That
        // inflated counter crossed the 90% emergency threshold on long
        // multi-tool turns and triggered destructive compaction on live chat
        // sessions (sprint-936 founder bug). Zero-usage responses (streaming
        // providers without a usage chunk) keep the previous reading.
        const stepOccupancy = response.usage.inputTokens + response.usage.outputTokens;
        if (stepOccupancy > 0) {
          this.config.budget.contextWindow.currentTokens = stepOccupancy;
        }

        // Cost accounting — feeds the maxCostUsd ceiling. The SDK is
        // pricing-table-agnostic; costFn is injected by the caller.
        let stepCostUsd = 0;
        if (this.config.costFn) {
          try {
            stepCostUsd = this.config.costFn({
              inputTokens: response.usage.inputTokens,
              outputTokens: response.usage.outputTokens,
            });
          } catch {
            stepCostUsd = 0; // pricing failure is non-fatal
          }
          cumulativeCostUsd += stepCostUsd;
        }

        await this.config.tracker?.recordStep({
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          toolCalls: response.toolCalls.length,
          costUsd: stepCostUsd,
        });

        // Remote-control: emit the step delta to observers.
        sink?.emit(
          makeEvent("run.step", {
            stepIndex: this.config.budget.stepCount - 1,
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            costUsd: stepCostUsd,
          }),
        );

        // ─── No tool call → assistant finalises. ────────────────────────
        if (response.toolCalls.length === 0) {
          // ... SAUF si le contenu ECRIT un appel d'outil au lieu de l'emettre.
          // Mesure du 2026-08-30 : le modele a rendu `<brain_query q="..." />`
          // en texte, la boucle a conclu, et il a ensuite invente le resultat
          // (« rien n'est ressorti ») pour raisonner dessus. Le founder a recu
          // une conclusion tiree d'une recherche qui n'a jamais eu lieu.
          // On le reprend UNE fois ; s'il recidive, on laisse passer et
          // l'annotation du rendu rend la fabrication visible.
          const narrated = unexecutedToolCallMarkers(response.content);
          if (narrated.length > 0 && narratedToolCallNudges < 1) {
            narratedToolCallNudges += 1;
            stepsWithoutTool += 1;
            log.push({ role: "assistant", content: response.content });
            log.push({
              role: "user",
              content: `You WROTE a tool invocation (${narrated.join(", ")}) as text instead of emitting it as a tool call. No tool ran and no result exists, so do not infer anything from it. Either emit a real tool call, or answer without claiming you searched.`,
            });
            continue;
          }

          // Second visage du meme defaut, sans aucune syntaxe d'outil dans le
          // texte : un VERDICT sur l'etat de la memoire alors qu'aucune
          // recherche n'a tourne. Mesure du 2026-08-31 a 16:02 UTC, « je n'ai
          // rien trouve dans mes notes sur tes preferences cafe », rendu en UNE
          // etape et zero appel. Voir `unobserved-memory-claim.ts`.
          const memoryWarning = unobservedMemoryClaimWarning(response.content, {
            lookupRan: memoryLookupRan,
          });
          if (memoryWarning !== null && unobservedMemoryNudges < 1) {
            unobservedMemoryNudges += 1;
            stepsWithoutTool += 1;
            log.push({ role: "assistant", content: response.content });
            log.push({
              role: "user",
              content:
                "You stated what is NOT in memory, but no memory lookup ran in this turn : you did not observe that absence. Either call the memory tool now and answer from its result, or say plainly that you have not checked. Never report an absence you did not establish.",
            });
            continue;
          }

          // La reprise est epuisee et le verdict tient : on ANNOTE, on ne
          // supprime pas. Le journal garde le texte nu (c'est l'historique du
          // modele) ; l'humain, lui, recoit le message avec ce qui le qualifie.
          const shownMessage =
            memoryWarning === null ? response.content : `${memoryWarning}\n\n${response.content}`;
          log.push({ role: "assistant", content: response.content });
          finalMessage = shownMessage;
          stopReason = "complete";
          // Stream the ephemeral deltas first (live cursor), then the durable
          // TEXT_MESSAGE_END (unchanged record).
          stepTextStream.finalize(shownMessage);
          sink?.emit(makeEvent("assistant.message", { content: shownMessage }));
          break;
        }

        if (response.content.trim() !== "") {
          stepTextStream.finalize(response.content);
          sink?.emit(makeEvent("assistant.message", { content: response.content }));
        }

        log.push({ role: "assistant", content: response.content });
        stepsWithoutTool = 0;

        // ─── Execute each tool call sequentially. ───────────────────────
        let userCancelled = false;
        for (const tc of response.toolCalls) {
          // Cooperative cancellation ; before each tool dispatch.
          if (this.config.abortSignal?.aborted) {
            stopReason = "aborted";
            userCancelled = true; // reuse the existing break-out flag
            break;
          }

          recentCalls.push({ name: tc.name, args: tc.args });

          const tool = this.config.tools.get(tc.name);
          const isDangerous = tool?.dangerous === true;

          // ─── Capability gate (Biscuit) — pre-dispatch. ────────────────
          if (this.config.capabilityGate) {
            let verdict: CapabilityGateVerdict;
            try {
              verdict = await this.config.capabilityGate.verify({
                toolName: tc.name,
                budgetUsed: budgetUsedUsd,
                mcpScopes: tool?.mcpScopes,
              });
            } catch {
              verdict = { allowed: false, reason: "gate_error" };
            }
            if (!verdict.allowed) {
              try {
                this.config.onToolDenied?.({
                  toolName: tc.name,
                  reason: verdict.reason,
                  budgetUsed: budgetUsedUsd,
                });
              } catch {
                /* best-effort */
              }
              rootSpan.addEvent("gen_ai.tool.denied", {
                tool_name: tc.name,
                reason: verdict.reason,
              });
              log.push({
                role: "tool",
                content: `ERROR: capability_denied:${verdict.reason}`,
                toolName: tc.name,
              });
              continue; // Token expiry / scope deny is graceful — try next call.
            }
            // Account this call against the per-loop budget for the
            // verifier on subsequent calls.
            budgetUsedUsd += this.config.costPerToolCallUsd ?? 0;
          }

          // ─── Action gate (governed VerifierBattery) ; pre-act, fail-closed. ──
          if (this.config.actionGate) {
            let av: ActionGateVerdict;
            try {
              av = await this.config.actionGate.verify({
                toolName: tc.name,
                args: tc.args,
                budgetUsed: budgetUsedUsd,
              });
            } catch {
              av = { allowed: false, reason: "action_gate_error" };
            }
            if (!av.allowed) {
              try {
                this.config.onActionDenied?.({
                  toolName: tc.name,
                  reason: av.reason,
                  budgetUsed: budgetUsedUsd,
                  ...(av.kind !== undefined ? { kind: av.kind } : {}),
                });
              } catch {
                /* best-effort */
              }
              rootSpan.addEvent("gen_ai.action.denied", {
                tool_name: tc.name,
                reason: av.reason,
                ...(av.kind !== undefined ? { kind: av.kind } : {}),
              });
              log.push({
                role: "tool",
                content: `ERROR: ${av.kind ?? "action_denied"}:${av.reason}`,
                toolName: tc.name,
              });
              continue; // fail-closed graceful ; try next call.
            }
          }

          // A dangerous tool may be downgraded per-call by an injected
          // predicate (e.g. read-only bash). No predicate / a thrown predicate
          // / a true return all keep the dangerous tool gated (fail-closed).
          let needsApproval = isDangerous;
          if (isDangerous && this.config.approvalPredicate) {
            try {
              needsApproval = this.config.approvalPredicate({
                name: tc.name,
                args: tc.args,
              });
            } catch {
              needsApproval = true;
            }
          }

          if (needsApproval) {
            if (!this.config.approvalChannel) {
              // No approver wired ; fail closed. With honest stops on, name the
              // real cause (no approval channel) rather than imply a user
              // cancellation that never happened.
              stopReason = this.config.honestApprovalStops ? "approval_denied" : "user_cancelled";
              userCancelled = true;
              break;
            }
            // Une attente déjà restée sans réponse ne se rouvre pas : le même
            // outil est refusé sur-le-champ, sans consommer un second timeout.
            if (this.config.continueOnApprovalTimeout && approvalTimedOutTools.has(tc.name)) {
              log.push({
                role: "tool",
                content:
                  `ERROR: approval_timeout:${tc.name} — une demande d'approbation pour cet ` +
                  "outil est déjà restée sans réponse dans ce run ; l'appel est refusé sans " +
                  "nouvelle attente. Poursuis autrement, ou termine en disant ce qui reste à " +
                  "faire une fois l'accord obtenu.",
                toolName: tc.name,
              });
              continue; // fail-closed graceful, comme un action_denied.
            }
            const wait = await this.awaitApproval(tc, tool, budgetUsedUsd);
            // Un seul point de tir, avant tout branchement par issue : l'appelant
            // apprend l'ISSUE definitive une fois, quelle que soit la branche qui
            // la traite ensuite (best-effort, ne modifie jamais la decision deja
            // prise par awaitApproval).
            try {
              this.config.onApprovalResolved?.({
                toolName: tc.name,
                outcome: wait.outcome,
                ...(wait.outcome === "gate_revoked" ? { reason: wait.reason } : {}),
              });
            } catch {
              /* best-effort ; la décision est déjà prise */
            }
            if (wait.outcome === "gate_revoked") {
              // ADR-ECO-135 §1.3 : la carte s'est fermée parce que le gate ne
              // couvre plus cet appel (ex. la posture a changé pendant
              // l'attente), jamais parce qu'un humain a répondu. Refuse
              // l'APPEL, pas le TOUR — même discipline que le timeout ci-
              // dessous : le travail en cours survit à une carte close.
              try {
                this.config.onActionDenied?.({
                  toolName: tc.name,
                  reason: wait.reason,
                  budgetUsed: budgetUsedUsd,
                  ...(wait.kind !== undefined ? { kind: wait.kind } : {}),
                });
              } catch {
                /* best-effort */
              }
              rootSpan.addEvent("gen_ai.action.denied", {
                tool_name: tc.name,
                reason: wait.reason,
                ...(wait.kind !== undefined ? { kind: wait.kind } : {}),
              });
              log.push({
                role: "tool",
                content: `ERROR: ${wait.kind ?? "action_denied"}:${wait.reason}`,
                toolName: tc.name,
              });
              continue;
            }
            if (wait.outcome !== "approved") {
              // Timeout (personne n'a répondu) : on refuse l'APPEL, pas le
              // TOUR. Le fail-closed tient (l'outil ne tourne pas) ; ce qui
              // change est que le travail en cours survit à une carte non vue.
              if (wait.outcome === "timeout" && this.config.continueOnApprovalTimeout) {
                approvalTimedOutTools.add(tc.name);
                const waitedMs = this.config.approvalTimeoutMs ?? 60_000;
                try {
                  this.config.onApprovalTimeout?.({ toolName: tc.name, timeoutMs: waitedMs });
                } catch {
                  /* best-effort ; la décision est déjà prise */
                }
                rootSpan.addEvent("gen_ai.approval.timeout", {
                  tool_name: tc.name,
                  timeout_ms: waitedMs,
                });
                log.push({
                  role: "tool",
                  content:
                    `ERROR: approval_timeout:${tc.name} — personne n'a répondu à la demande ` +
                    `d'approbation en ${Math.round(waitedMs / 1000)} s, donc l'appel est refusé. ` +
                    "L'outil n'a PAS tourné. Poursuis autrement, ou termine en disant ce qui " +
                    "reste à faire une fois l'accord obtenu.",
                  toolName: tc.name,
                });
                continue;
              }
              stopReason = this.config.honestApprovalStops
                ? wait.outcome === "timeout"
                  ? "approval_timeout"
                  : "approval_denied"
                : "user_cancelled";
              userCancelled = true;
              break;
            }
          }

          // ── Read-result cache ────────────────────────────────────────────
          // For idempotent read-only tools (read_file, list_directory, cat,
          // ls, grep…), return cached result on repeat calls instead of
          // re-executing. This is transparent to the model — it gets the
          // same info without triggering the WorldStateHashTracker collision
          // path and without burning a tool-execution round-trip.
          const cacheKey = isReadOnlyTool(tc.name, tc.args)
            ? canonicalStateHash(tc.name, tc.args, "")
            : null;
          const cached = cacheKey ? readResultCache.get(cacheKey) : null;

          let toolContent: string;
          if (cached !== undefined && cached !== null) {
            // Return cached content — skip actual execution.
            toolContent = cached;
            // Cache hit : le resultat vient d'une execution qui a REUSSI plus tot,
            // c'est donc bien une observation.
            if (isMemoryLookupTool(tc.name)) memoryLookupRan = true;
            log.push({ role: "tool", content: toolContent, toolName: tc.name });
            // Don't run WorldStateHashTracker for cache hits — it's intentional.
            recentCalls.push({ name: tc.name, args: tc.args });
            this.config.budget.stepCount++;
            continue;
          }

          const tSpan = toolSpan(this.tracer, tc.name, tc.args);
          const argsPreview = boundedArgsPreview(tc.args);
          const callId = cryptoRandomId();

          // ── T6a veto window ───────────────────────────────────────────────
          // Emit tool.intent before doing anything irreversible, then wait
          // up to vetoWindowMs for a matching signal on the veto channel.
          // A vetoed call is replaced with a structured "[vetoed by X]"
          // result the LLM sees on its next step.
          const vetoChan = this.config.vetoChannel;
          const vetoWindow = this.config.vetoWindowMs ?? 0;
          if (vetoChan && vetoWindow > 0 && sink) {
            sink.emit(
              makeEvent("tool.intent", {
                callId,
                toolName: tc.name,
                argsPreview,
                vetoWindowMs: vetoWindow,
              }),
            );
            const veto = await vetoChan.await(callId, vetoWindow);
            if (veto) {
              const reasonSuffix = veto.reason ? `: ${veto.reason}` : "";
              const vetoedContent = `[vetoed by ${veto.by}${reasonSuffix}]`;
              sink.emit(
                makeEvent("tool.call.end", {
                  callId,
                  toolName: tc.name,
                  ok: false,
                  resultPreview: vetoedContent,
                }),
              );
              log.push({
                role: "tool",
                content: vetoedContent,
                toolName: tc.name,
              });
              this.config.budget.stepCount++;
              tSpan.end();
              continue;
            }
          }
          // ── /T6a ──────────────────────────────────────────────────────────

          sink?.emit(
            makeEvent("tool.call.start", {
              callId,
              toolName: tc.name,
              argsPreview,
            }),
          );
          const toolStartMs = Date.now();
          const result = await this.config.tools.execute(tc.name, tc.args);
          recordToolResult(tSpan, {
            success: result.ok,
            errorMessage: result.ok ? undefined : result.error.message,
          });
          tSpan.end();

          toolContent = summariseToolResult(result, this.config.toolResultMaxChars);
          sink?.emit(
            makeEvent("tool.call.end", {
              callId,
              toolName: tc.name,
              ok: result.ok,
              resultPreview: toolContent.slice(0, 500),
              durationMs: Date.now() - toolStartMs,
            }),
          );
          // Store in read-result cache if this is a read-only tool.
          if (cacheKey) {
            readResultCache.set(cacheKey, toolContent);
          }
          // Le SUCCES seul vaut observation. Un lookup en erreur n'a rien vu ; le
          // compter tairait la garde precisement quand l'absence est la plus fausse.
          if (isMemoryLookupTool(tc.name) && result.ok) memoryLookupRan = true;
          log.push({ role: "tool", content: toolContent, toolName: tc.name });

          // World-state hash — loop detection with self-correction (O(1)).
          // On first collision: inject a correction message and continue.
          // Only stop after MAX_LOOP_CORRECTIONS ignored corrections.
          const obs = worldStateTracker.observe(
            tc.name,
            tc.args,
            toolContent,
            this.config.budget.stepCount,
          );
          if (obs.isCollision && !this.config.disableLoopDetection) {
            loopCorrectionCount += 1;
            rootSpan.addEvent("gen_ai.agent.loop_correction", {
              tool_name: tc.name,
              correction: loopCorrectionCount,
              first_step: obs.previousStep ?? -1,
              repeat_step: this.config.budget.stepCount,
            });

            if (loopCorrectionCount >= MAX_LOOP_CORRECTIONS) {
              stopReason = "loop_definitive";
              loopDetail = {
                toolName: tc.name,
                hash: obs.hash,
                firstStep: obs.previousStep ?? -1,
                repeatStep: this.config.budget.stepCount,
              };
              rootSpan.addEvent("gen_ai.agent.loop_definitive", {
                tool_name: tc.name,
                first_step: obs.previousStep ?? -1,
                repeat_step: this.config.budget.stepCount,
              });
              break;
            }

            // Inject corrective context — agent must try a different approach.
            const pathHint =
              typeof tc.args === "object" &&
              tc.args !== null &&
              "path" in (tc.args as Record<string, unknown>)
                ? ` (path: ${String((tc.args as Record<string, string>).path)})`
                : typeof tc.args === "object" &&
                    tc.args !== null &&
                    "command" in (tc.args as Record<string, unknown>)
                  ? ` (cmd: ${String((tc.args as Record<string, string>).command).slice(0, 60)})`
                  : "";
            const correctionMsg = `[LOOP CORRECTION ${loopCorrectionCount}/${MAX_LOOP_CORRECTIONS}] STOP. You already ran \`${tc.name}\`${pathHint} at step ${
              obs.previousStep ?? "?"
            } with an IDENTICAL result. This is a loop. You MUST take a completely different action now. If you are looking for a project or file, check the conversation history — the location was likely already established. Do NOT repeat filesystem exploration commands.`;
            log.push({ role: "user", content: correctionMsg });
          }

          // Progress-based stall detection (replaces heuristic when embedFn provided)
          if (progressTracker && !this.config.disableLoopDetection) {
            const snapshot = await progressTracker.observe(toolContent);
            if (snapshot.isPlateau) {
              loopCorrectionCount += 1;
              if (loopCorrectionCount >= MAX_LOOP_CORRECTIONS) {
                stopReason = "loop_definitive";
                loopDetail = {
                  toolName: tc.name,
                  hash: "progress_plateau",
                  firstStep: this.config.budget.stepCount - snapshot.observations,
                  repeatStep: this.config.budget.stepCount,
                };
                break;
              }
              const plateauMsg = `[PROGRESS PLATEAU ${loopCorrectionCount}/${MAX_LOOP_CORRECTIONS}] No measurable progress toward the goal for the last ${snapshot.observations} steps (similarity delta: ${snapshot.progress.toFixed(3)}). Think differently. What concrete, new action would directly advance the task?`;
              log.push({ role: "user", content: plateauMsg });
            }
          }

          // Wire TrajectoryConfidenceTracker
          const stepConf = 1.0 - loopCorrectionCount / MAX_LOOP_CORRECTIONS;
          trajectoryTracker.observe(stepConf);
          // Low trajectory confidence = interrupt recommended (surfaced via loopDetail in future)
        }

        if (userCancelled) break;
        if (stopReason === "loop_definitive") break;

        // ─── Coherence check on tool loop / stall. ──────────────────────
        const verdict = coherence.check(recentCalls, stepsWithoutTool);
        this.config.budget.coherenceScore = verdict.score;
        if ((verdict.isLoop || verdict.isStall) && !this.config.disableLoopDetection) {
          stopReason = "incoherent";
          rootSpan.addEvent("gen_ai.agent.incoherent", {
            is_loop: verdict.isLoop,
            is_stall: verdict.isStall,
          });
          break;
        }
      }

      // Grounded run-memory: journal the tail messages of the final
      // iteration. The clean-completion final assistant message is excluded:
      // the host's post-run sink records it (no double write).
      await journalNewEntries(stopReason === "complete");

      rootSpan.setAttribute("gen_ai.agent.stop_reason", stopReason);
      rootSpan.setStatus({ code: SpanStatusCode.OK });

      // ── Skill-capture completion hook (Beyond-Hermes W2-T4) ──
      // Best-effort, exactly once, only on a clean completion, BEFORE
      // run.finished. Fail-soft: a capture-hook fault never changes the run
      // result. A pure NOTIFICATION ; the governed write-time battery + sink
      // live in the host (preste's governedSkillCapture), keeping the loop
      // free of host I/O. Promoted from the W2-T3 L1 prototype per
      // rules/delivery/level-discipline.md.
      if (stopReason === "complete" && this.config.skillCapture) {
        try {
          await this.config.skillCapture.onComplete({
            runId,
            traceId,
            stopReason,
            finalMessage,
            stepCount: this.config.budget.stepCount,
          });
        } catch {
          // fail-soft: a capture-hook fault must not fail the agent run
        }
      }

      sink?.emit(
        makeEvent("run.finished", {
          runId,
          stopReason,
          stepCount: this.config.budget.stepCount,
          costUsd: cumulativeCostUsd,
          finishedAt: new Date().toISOString(),
        }),
      );
      return {
        finalMessage,
        stopReason,
        budgetFinal: this.config.budget,
        traceId,
        costUsd: cumulativeCostUsd,
        ...(loopDetail ? { loopDetail } : {}),
      };
    } catch (err) {
      const errorMessage = (err as Error)?.message ?? String(err);
      rootSpan.recordException(err as Error);
      sink?.emit(
        makeEvent("run.finished", {
          runId,
          stopReason: "error",
          stepCount: this.config.budget.stepCount,
          costUsd: cumulativeCostUsd,
          finishedAt: new Date().toISOString(),
        }),
      );
      rootSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorMessage,
      });
      return {
        finalMessage: "",
        stopReason: "error",
        errorMessage,
        budgetFinal: this.config.budget,
        traceId,
      };
    } finally {
      rootSpan.end();
    }
  }

  private async awaitApproval(
    tc: {
      name: string;
      args: unknown;
    },
    tool: AgentTool | undefined,
    budgetUsed: number,
  ): Promise<ApprovalWaitOutcome> {
    const channel = this.config.approvalChannel;
    // Guarded by the caller (approvalChannel presence checked before this
    // runs) ; a missing channel here is a fail-closed timeout, never approval.
    if (!channel) return { outcome: "timeout" };
    const timeoutMs = this.config.approvalTimeoutMs ?? 60_000;
    const pollMs = this.config.approvalPollIntervalMs ?? 500;

    const requestId = await channel.send({
      agentId: this.config.agentId,
      action: tc.name,
      context: safeStringify(tc.args),
      timeoutMs,
      // Display-only risk metadata for the HITL ceremony ; absent when the
      // tool declares no RiskVector (byte-identical for every existing tool).
      ...(tool?.risk ? { risk: toApprovalRisk(tool.risk) } : {}),
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // Re-check the action gate on every tick (ADR-ECO-135 §1.3): a card
      // already open closes fail-closed the instant the gate no longer
      // allows it — a session posture tightened mid-wait must not leave a
      // human looking at a card they can no longer act on. The reverse never
      // happens here: a gate that now allows what it denied at send-time
      // changes nothing (no retroactive auto-approval of a pending card).
      // Cost: one extra `actionGate.verify` per poll tick (same cadence as
      // `channel.poll` itself, ~pollMs) for the lifetime of the wait ; a
      // host whose gate does real I/O (e.g. a `git status` per tick for the
      // posture gate's write_file classification) accepts that cost at the
      // same order of magnitude the channel polling already does.
      if (this.config.actionGate) {
        let av: ActionGateVerdict | undefined;
        try {
          av = await this.config.actionGate.verify({
            toolName: tc.name,
            args: tc.args,
            budgetUsed,
          });
        } catch {
          av = undefined; // a transient re-check failure never revokes a live card.
        }
        if (av && !av.allowed) {
          await channel.cancel(requestId).catch(() => {
            /* best-effort */
          });
          return {
            outcome: "gate_revoked",
            reason: av.reason,
            ...(av.kind !== undefined ? { kind: av.kind } : {}),
          };
        }
      }
      const verdict = await channel.poll(requestId);
      if (verdict !== null) {
        if (verdict.approved === true) return { outcome: "approved" };
        // Distinguish an explicit deny from a channel-internal fail-closed
        // timeout via the verdict's own `timedOut` flag (never a magic `by`
        // string) so the honest stop reasons stay accurate.
        return { outcome: verdict.timedOut === true ? "timeout" : "denied" };
      }
      await sleep(pollMs);
    }
    await channel.cancel(requestId).catch(() => {
      /* best-effort */
    });
    // Our own wait window elapsed with no verdict ; a fail-closed timeout.
    return { outcome: "timeout" };
  }
}

// ─── Helpers (unexported) ─────────────────────────────────────────────────

function cryptoRandomId(): string {
  const bytes = new Uint8Array(8);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : (JSON.stringify(v) ?? "null");
  } catch {
    return "[unserialisable]";
  }
}

/** Per-field character cap applied by `boundedArgsPreview`. Mirrors the
 * previous global `.slice(0, 500)` cap, applied per field instead of to the
 * serialized blob as a whole. */
const ARGS_PREVIEW_FIELD_MAX = 500;

/** Defensive cap on the number of top-level fields carried into an
 * argsPreview. A real tool call rarely declares more than a handful of
 * arguments ; this only guards a pathological call from an unbounded
 * preview. */
const ARGS_PREVIEW_MAX_FIELDS = 50;

/**
 * Build the wire args preview for a tool call. Bounds EACH top-level field
 * instead of slicing the serialized JSON as a whole (the previous
 * `JSON.stringify(args).slice(0, 500)`), which cut mid-string or
 * mid-structure for almost any multi-argument call and handed the client
 * invalid JSON it could only recover field-by-field (sprint-1067
 * t3-args-truncation ; found by t3-ux-polish's salvage band-aid, marked
 * "tronqué par l'hôte"). Truncating each string value BEFORE the final
 * `JSON.stringify` keeps the emitted preview valid JSON for object args, so
 * the client's whole-preview `JSON.parse` now succeeds in the common case
 * instead of falling back to salvage.
 *
 * Non-string fields (numbers, booleans, null, nested objects/arrays) are
 * left intact ; only long strings blow up preview size in practice, and
 * bounding nested structures is a separate problem this fix does not take
 * on. A call with more than `ARGS_PREVIEW_MAX_FIELDS` top-level keys has its
 * extra fields dropped, recorded by one marker key ; additive, so a client
 * that only reads the fields it knows about parses the result unchanged.
 */
function boundedArgsPreview(args: unknown): string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    // Never happens for a real tool call (every tool-calling API requires an
    // object), but `args` is typed `unknown` at the call site — preserve the
    // legacy whole-value slice for this path, unchanged.
    return JSON.stringify(args ?? {}).slice(0, ARGS_PREVIEW_FIELD_MAX);
  }
  const entries = Object.entries(args as Record<string, unknown>);
  const bounded: Record<string, unknown> = {};
  for (const [key, value] of entries.slice(0, ARGS_PREVIEW_MAX_FIELDS)) {
    bounded[key] =
      typeof value === "string" && value.length > ARGS_PREVIEW_FIELD_MAX
        ? `${value.slice(0, ARGS_PREVIEW_FIELD_MAX)}\n[value truncated: showing ${ARGS_PREVIEW_FIELD_MAX} of ${value.length} chars]`
        : value;
  }
  if (entries.length > ARGS_PREVIEW_MAX_FIELDS) {
    bounded["…"] = `[${entries.length - ARGS_PREVIEW_MAX_FIELDS} more field(s) omitted]`;
  }
  return safeStringify(bounded);
}

function summariseToolResult(r: ToolResult, maxChars?: number): string {
  if (!r.ok) {
    return `ERROR: ${r.error.message}`;
  }
  const full = safeStringify(r.data);
  // Unset cap = legacy hard slice, byte-identical for existing hosts.
  if (maxChars === undefined) return full.slice(0, 2000);
  if (full.length <= maxChars) return full;
  return `${full.slice(0, maxChars)}\n[tool result truncated: showing ${maxChars} of ${full.length} chars]`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

// ─── PUBLIC SURFACE ───────────────────────────────────────────────────────

export { AgentLoopImpl as AgentLoop };
export type { AgentLoopRunResult, AgentLoopConfig };
