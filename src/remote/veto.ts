/**
 * remote/veto — the VetoChannel port for the T6a tool-intent veto window.
 *
 * Before every tool call, the AgentLoop emits `tool.intent` (with a
 * `vetoWindowMs` budget) and then waits on this channel for up to that many
 * milliseconds. If a veto signal arrives, the loop SKIPS the tool call and
 * records a `[vetoed by <by>]` result; otherwise the call proceeds normally.
 *
 * The channel is keyed by `callId` so several pending tool intents can be
 * vetoed independently. A signal submitted before any wait is buffered, so
 * the remote client cannot race the loop into executing a doomed call.
 *
 * @public @since 2.15.0 — preste remote-control T6a (veto window)
 */

/**
 * One veto vote, scoped to a specific pending tool call.
 * @public
 */
export interface VetoSignal {
  /** The callId from the tool.intent event the veto targets. */
  callId: string;
  /** Identifier of the rejecter — `"telegram:<chatId>"`, `"remote-http"`, etc. */
  by: string;
  /** Optional human-readable reason. */
  reason?: string;
  /** ISO8601 time the veto was raised. */
  at: string;
}

/**
 * Pre-tool-call veto bus. Producers (remote transports, gateway adapters)
 * call `submit` when a remote client rejects an intent; the AgentLoop calls
 * `await(callId, windowMs)` and resolves the moment a matching signal lands
 * or the window elapses.
 * @public
 */
export interface VetoChannel {
  /** Submit a veto signal for `signal.callId`. Idempotent on duplicate callIds. */
  submit(signal: VetoSignal): void;
  /**
   * Wait up to `windowMs` for a signal whose `callId` matches. Returns the
   * signal if one arrives, or `null` if the window elapses.
   */
  await(callId: string, windowMs: number): Promise<VetoSignal | null>;
  /** Number of signals currently buffered (test/debug introspection). */
  pendingCount(): number;
}

/**
 * Process-local in-memory veto channel. A signal arriving BEFORE a wait is
 * buffered and consumed by the first matching `await`; a wait without a
 * pending signal resolves `null` when its window elapses.
 * @public
 */
export class InMemoryVetoChannel implements VetoChannel {
  private readonly buffered = new Map<string, VetoSignal>();
  private readonly waiters = new Map<string, (signal: VetoSignal | null) => void>();

  submit(signal: VetoSignal): void {
    const waiter = this.waiters.get(signal.callId);
    if (waiter) {
      this.waiters.delete(signal.callId);
      waiter(signal);
      return;
    }
    this.buffered.set(signal.callId, signal);
  }

  async await(callId: string, windowMs: number): Promise<VetoSignal | null> {
    const pending = this.buffered.get(callId);
    if (pending) {
      this.buffered.delete(callId);
      return pending;
    }
    if (windowMs <= 0) return null;
    return new Promise<VetoSignal | null>((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiters.get(callId)) {
          this.waiters.delete(callId);
          resolve(null);
        }
      }, windowMs);
      timer.unref?.();
      this.waiters.set(callId, (signal) => {
        clearTimeout(timer);
        resolve(signal);
      });
    });
  }

  pendingCount(): number {
    return this.buffered.size;
  }
}
