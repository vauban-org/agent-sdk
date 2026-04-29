/**
 * subscribeToRun — SSE client for /api/runs/:id/stream.
 *
 * Uses fetch + ReadableStream for uniform Node 18+ / browser support.
 * EventSource is NOT used — it lacks custom headers (needed for auth tokens)
 * and behaves differently across runtimes.
 *
 * Protocol:
 *   - Events are SSE-formatted: "event: NAME\nid: ID\ndata: JSON\n\n"
 *   - last-event-id is forwarded via "Last-Event-ID" header on reconnect
 *   - Auto-reconnect on stream close (max 3 retries, exponential backoff)
 *   - AbortSignal propagated; close() aborts the controller
 *
 * Sprint: command-center:sprint-523:quick-6
 */

import type {
  RunStep,
  RunStreamEventName,
  RunStreamEvent,
} from "./types.js";

export interface SubscribeToRunOptions {
  baseUrl: string;
  getToken?: () => Promise<string>;
  /** UUID of the last step_id received — enables resume catch-up. */
  lastEventId?: string;
  signal?: AbortSignal;
  onStep?: (step: RunStep, event: "step_existing" | "step_new") => void;
  onComplete?: (data: { status: string; duration_ms?: number }) => void;
  onError?: (err: Error) => void;
}

export interface SubscribeHandle {
  close: () => void;
}

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1_000;

/**
 * Parse a single SSE block (delimited by "\n\n") into a RunStreamEvent.
 * Returns null if the block is incomplete or unrecognised.
 */
function parseSseBlock(block: string): RunStreamEvent | null {
  let eventName: RunStreamEventName | null = null;
  let eventId: string | undefined;
  let dataLine: string | undefined;

  for (const raw of block.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("event: ")) {
      eventName = line.slice("event: ".length) as RunStreamEventName;
    } else if (line.startsWith("id: ")) {
      eventId = line.slice("id: ".length);
    } else if (line.startsWith("data: ")) {
      dataLine = line.slice("data: ".length);
    }
  }

  if (!eventName || dataLine === undefined) return null;

  let data: RunStreamEvent["data"];
  if (dataLine === "") {
    data = undefined;
  } else {
    try {
      data = JSON.parse(dataLine) as RunStreamEvent["data"];
    } catch {
      return null;
    }
  }

  return { name: eventName, id: eventId, data };
}

/**
 * Stream the SSE response body, emitting parsed events via callbacks.
 * Returns the last event id seen (for reconnect headers).
 */
async function streamResponse(
  response: Response,
  opts: SubscribeToRunOptions,
  lastEventIdRef: { value: string | undefined },
  abortSignal: AbortSignal,
): Promise<"complete" | "reconnect"> {
  const body = response.body;
  if (!body) {
    throw new Error("Response body is null — cannot stream SSE");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (!abortSignal.aborted) {
      const { done, value } = await reader.read();
      if (done) return "reconnect";

      buffer += decoder.decode(value, { stream: true });

      // Split on double-newline (SSE event boundary).
      const blocks = buffer.split("\n\n");
      // Keep the last (possibly incomplete) chunk in the buffer.
      buffer = blocks.pop() ?? "";

      for (const block of blocks) {
        if (!block.trim()) continue;
        const event = parseSseBlock(block);
        if (!event) continue;

        // Track last event id for resume.
        if (event.id) lastEventIdRef.value = event.id;

        switch (event.name) {
          case "step_existing":
          case "step_new": {
            if (opts.onStep && event.data && typeof event.data === "object" && "id" in event.data) {
              opts.onStep(event.data as RunStep, event.name);
            }
            break;
          }
          case "run_complete": {
            if (opts.onComplete) {
              const d = event.data as { status: string; duration_ms?: number } | undefined;
              opts.onComplete(d ?? { status: "unknown" });
            }
            return "complete";
          }
          case "error": {
            const d = event.data as { error: string } | undefined;
            if (opts.onError) {
              opts.onError(new Error(d?.error ?? "stream_error"));
            }
            break;
          }
          case "ping":
            // Heartbeat — no action needed.
            break;
          default:
            // Unknown event names are silently ignored per SSE spec.
            break;
        }
      }
    }
    return "reconnect";
  } finally {
    reader.cancel().catch(() => {
      // Ignore cancel errors — stream may already be closed.
    });
  }
}

export async function subscribeToRun(
  runId: string,
  opts: SubscribeToRunOptions,
): Promise<SubscribeHandle> {
  const controller = new AbortController();

  // Merge caller's signal with our internal controller.
  const mergedSignal = opts.signal
    ? AbortSignal.any
      ? AbortSignal.any([opts.signal, controller.signal])
      : (() => {
          const ac = new AbortController();
          opts.signal!.addEventListener("abort", () => ac.abort());
          controller.signal.addEventListener("abort", () => ac.abort());
          return ac.signal;
        })()
    : controller.signal;

  const lastEventIdRef: { value: string | undefined } = {
    value: opts.lastEventId,
  };

  // Run the connection loop in the background; do not await.
  void (async () => {
    let retries = 0;

    while (!mergedSignal.aborted && retries <= MAX_RETRIES) {
      const url = `${opts.baseUrl.replace(/\/$/, "")}/api/runs/${runId}/stream`;

      const headers: Record<string, string> = {
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      };

      if (opts.getToken) {
        try {
          const token = await opts.getToken();
          headers["Authorization"] = `Bearer ${token}`;
        } catch (err) {
          opts.onError?.(err instanceof Error ? err : new Error(String(err)));
          break;
        }
      }

      if (lastEventIdRef.value) {
        headers["Last-Event-ID"] = lastEventIdRef.value;
      }

      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers,
          signal: mergedSignal,
        });
      } catch (err) {
        if (mergedSignal.aborted) break;
        opts.onError?.(err instanceof Error ? err : new Error(String(err)));
        // Backoff before retry.
        retries++;
        if (retries > MAX_RETRIES) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, BASE_BACKOFF_MS * 2 ** (retries - 1));
          mergedSignal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
        continue;
      }

      if (!response.ok) {
        opts.onError?.(new Error(`HTTP ${response.status}: ${response.statusText}`));
        break;
      }

      try {
        const outcome = await streamResponse(response, opts, lastEventIdRef, mergedSignal);
        if (outcome === "complete" || mergedSignal.aborted) break;
        // "reconnect" — retry after backoff.
        retries++;
        if (retries > MAX_RETRIES) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, BASE_BACKOFF_MS * 2 ** (retries - 1));
          mergedSignal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      } catch (err) {
        if (mergedSignal.aborted) break;
        opts.onError?.(err instanceof Error ? err : new Error(String(err)));
        retries++;
        if (retries > MAX_RETRIES) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, BASE_BACKOFF_MS * 2 ** (retries - 1));
          mergedSignal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }
    }
  })();

  return {
    close: () => controller.abort(),
  };
}
