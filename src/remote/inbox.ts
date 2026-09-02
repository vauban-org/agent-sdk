/**
 * remote/inbox — the InstructionInbox port.
 *
 * The inbound half of remote-control: a remote client (phone, Telegram, web)
 * enqueues instructions; the running agent loop drains them at step
 * boundaries and injects them as steering messages. This is what makes
 * interrupt-and-redirect mid-run possible — the founder's core requirement.
 *
 * Two instruction kinds:
 *   - normal — becomes a visible `user` message in the conversation log.
 *   - whisper — the agent sees it but it is NOT shown as a user turn (an
 *     out-of-band hint that does not pollute the transcript / attestation).
 *
 * @public @since 2.11.0 — preste remote-control T1
 */

/**
 * One instruction injected by a remote client.
 * @public
 */
export interface Instruction {
  text: string;
  /** Who injected it — e.g. "remote:phone", "telegram:<chatId>", "cli". */
  source: string;
  /** When true: steers the agent without becoming a visible user turn. */
  whisper: boolean;
  /** ISO8601 enqueue time. */
  at: string;
  /**
   * The client-generated, opaque correlation id from the originating control
   * envelope (a `steer`/`whisper`/`message` claim's `steerId`), when the
   * producer supplied one. Absent for an instruction with no claim id
   * (byte-identical to before this field existed). Threaded onto the
   * re-emitted `CUSTOM_INSTRUCTION_INJECTED` / `RUN_STARTED` event so a
   * controller can resolve its own optimistic echo by identity
   * (sprint-1067 t3-steerid-correlation).
   */
  steerId?: string;
}

/**
 * Inbound queue of remote instructions. The agent loop owns the consumer
 * side (`drain`); remote transports own the producer side (`enqueue`).
 * @public
 */
export interface InstructionInbox {
  /** Queue an instruction for the running agent to pick up. `steerId` is
   * additive ; a caller that never supplies one keeps the byte-identical
   * pre-existing behavior (no `steerId` on the drained {@link Instruction}). */
  enqueue(text: string, source: string, whisper?: boolean, steerId?: string): void;
  /** Remove and return all queued instructions (FIFO). Empties the queue. */
  drain(): Instruction[];
  /** Number of instructions currently queued. */
  size(): number;
}

/**
 * Process-local in-memory inbox. Suitable for a single-process agent +
 * its remote-control server. Modeled on `InMemoryApprovalStore`.
 * @public
 */
export class InMemoryInstructionInbox implements InstructionInbox {
  private readonly queue: Instruction[] = [];

  enqueue(text: string, source: string, whisper = false, steerId?: string): void {
    const trimmed = text.trim();
    if (trimmed === "") return; // ignore empty injections
    this.queue.push({
      text: trimmed,
      source,
      whisper,
      at: new Date().toISOString(),
      ...(steerId !== undefined ? { steerId } : {}),
    });
  }

  drain(): Instruction[] {
    return this.queue.splice(0, this.queue.length);
  }

  size(): number {
    return this.queue.length;
  }
}
