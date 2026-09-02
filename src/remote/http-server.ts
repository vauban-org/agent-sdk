/**
 * remote/http-server — reference HTTP+SSE transport for remote-control.
 *
 * Serves a `RemoteControlPort` over plain Node `http` (zero dependencies):
 *
 *   GET  /remote/health             liveness
 *   GET  /remote/state              JSON snapshot of SessionState
 *   GET  /remote/stream[?since=N]   SSE — backlog (seq > N) then live events
 *   POST /remote/inject             {text, whisper?} → InstructionInbox
 *   POST /remote/hitl/:id/approve   approve a parked HITL request
 *   POST /remote/hitl/:id/reject    reject a parked HITL request
 *   POST /remote/revoke/:jti        revoke a previously-minted sub-token
 *   GET  /remote/revocations        list currently-revoked jtis
 *
 * This is the LAN reference transport (T1). The relay client (T2) reuses the
 * same `RemoteControlPort` — the port/transport split means the relay is just
 * another adapter, no rework. Mirrors the pattern of `hitl/slack.ts` (a HITL
 * transport over the `ApprovalChannel` port).
 *
 * Security: optional Bearer token (constant-time compare). A non-loopback
 * bind WITHOUT a token is refused — fail closed.
 *
 * @public @since 2.11.0 — preste remote-control T1
 */

import { type Server, type ServerResponse, createServer } from "node:http";
import type { RemoteApprovalChannel } from "./approval.js";
import { DpopReplayStore, type EcP256Jwk, validateDpopProof } from "./dpop.js";
import type { PersistencePort } from "./persistence.js";
import type { RemoteControlPort } from "./port.js";
import { recordRevocation, resolveAuthScopeInstrumented } from "./sub-token-otel.js";
import { type SubTokenScope, rebindSubToken, scopeCovers, verifySubToken } from "./sub-token.js";

// ─── L3-B b2 (ADR-ECO-112) ; cross-install teammate crossing ────────────────
//
// A structural port, not a concrete import of the CLI's `TeammateMailboxHandle`
// (packages/cli/src/teammate-mailbox.ts) : this SDK package never depends on
// the CLI. The CLI wires an adapter that satisfies this interface into
// `RemoteControlServerOptions.teammateSend`.

/** One addressable session a `list_targets` answer names : a stable session
 * name plus its current runId. Structural (no CLI import) ; the CLI's
 * `TeammateTarget` (teammate-aliases.ts) satisfies it by shape. @public */
export interface TeammateTargetInfo {
  readonly name: string;
  readonly runId: string;
}

/** Outcome of {@link TeammateSendPort.deliverCrossInstall}. @public */
export interface TeammateSendOutcome {
  readonly accepted: boolean;
  /**
   * Present iff `accepted` is false ; a coarse, typed rejection name (e.g.
   * `"UnknownSourceError"`, `"InvalidSignatureError"`, `"ClockSkewError"`,
   * `"ReplayDetectedError"`, or the boundary rate-limit's error name) the
   * `/teammate/send` route maps to an HTTP status. Never a free-text detail ;
   * that would leak internals to an unauthenticated caller (D2 : the envelope
   * IS the credential, so the caller is untrusted until it authenticates).
   */
  readonly errorName?: string;
  /**
   * Present iff `accepted` AND the delivered envelope was a `list_targets`
   * control query : this install's opt-in, paired-peer-only addressable
   * targets ({name, runId}). Travels back in the `/teammate/send` 200 body so
   * the querying side persists it into its alias store. Absent for a normal
   * (ask/inform) delivery ; the answer to a control query is data the paired
   * caller already earned by authenticating (D2).
   */
  readonly targets?: readonly TeammateTargetInfo[];
}

/**
 * D2 (ADR-ECO-112) ; the pinned-peer signed envelope is the send credential
 * for a cross-install teammate crossing ; this route does NOT consume the
 * remote-control bearer/sub-token scope ladder (`sub-token.ts`). @public
 */
export interface TeammateSendPort {
  /**
   * Authenticate (the ADR-ECO-112 boundary checks : peer lookup, pinned-key
   * signature, clock skew, replay dedup, receive-side rate limit) and hand
   * off one cross-install envelope. Resolves once authentication has
   * settled ; NOT once any downstream receiver governance (recipient scope,
   * HITL gate, spotlight wrap) settles ; those keep running on the receiver
   * side regardless of what this promise resolves to. `envelope` is `unknown`
   * because it arrives as parsed JSON over the wire, unverified.
   */
  deliverCrossInstall(envelope: unknown): Promise<TeammateSendOutcome>;
}

/** Outcome of {@link TeammateEventSinkPort.receivePushedEvent}. @public @experimental */
export interface TeammateEventPushOutcome {
  readonly accepted: boolean;
  /** Present iff `!accepted` ; a coarse typed rejection name (e.g.
   * `"InvalidSignatureError"`, `"UnknownSourceError"`) mapped to an HTTP status. */
  readonly errorName?: string;
}

/**
 * SP1 event-push : the reverse of {@link TeammateSendPort}. A session PUSHES its
 * signed SessionEvents to a controller's `POST /teammate/events` ; the controller
 * wires this port to verify each event's Ed25519 signature against the pinned
 * SESSION key before accepting. The signed event IS the credential, so the route
 * does NOT consume this server's bearer/sub-token ladder (D2-symmetric to
 * `/teammate/send`). Absent (the default) : the route 404s.
 *
 * @public @experimental
 */
export interface TeammateEventSinkPort {
  /** Verify + accept one pushed event. `event` is `unknown` (parsed JSON over the
   * wire, unverified). Resolves ; never throws. */
  receivePushedEvent(event: unknown): Promise<TeammateEventPushOutcome>;
}

/** Typed rejection name -> HTTP status for `POST /teammate/send`. A name not
 * in this map (an adapter surprise) falls back to 401 ; fail-closed, never
 * a 2xx for an unrecognised rejection. */
const TEAMMATE_SEND_ERROR_STATUS: Readonly<Record<string, number>> = {
  UnknownSourceError: 401,
  InvalidSignatureError: 401,
  ClockSkewError: 401,
  ReplayDetectedError: 409,
  TeammateBoundaryRateLimitError: 429,
  NotCrossInstallEnvelope: 400,
  MalformedEnvelopeError: 400,
  NoRecipient: 404,
  // ADR-ECO-115 fa3 ; owner-fleet cert-chain boundary rejections. A malformed
  // or expired cert is an authentication failure (401) ; a revoked install is
  // an explicit, once-trusted cutoff (403 forbidden), distinct from an unknown
  // source, so the wire status is as honest as the boundary-ledger reason.
  CertChainInvalidError: 401,
  CertExpiredError: 401,
  InstallRevokedError: 403,
};

/** Bounded POST body cap for `/teammate/send` : the envelope's own `body`
 * field is capped at 16KiB (agent-sdk's `MAX_TEAMMATE_BODY_BYTES`) ; this
 * adds headroom for the surrounding envelope JSON (ids, signature, claim). */
const TEAMMATE_SEND_BODY_CAP = 24 * 1024;

// ─── sprint-893 d1 ; read-only teammates panel (ZD5) ────────────────────────
//
// A structural port, same shape discipline as `TeammateSendPort` above: this
// SDK package never depends on the CLI's daemon/peer-registry concretions.
// The CLI wires an adapter (peers.json + the daemon socket) that satisfies
// this interface into `RemoteControlServerOptions.teammateInfo`.

/** One pinned peer (ADR-ECO-112 a1 registry), read-only projection. @public */
export interface TeammateInfoPeer {
  readonly peerId: string;
  readonly label?: string;
  /** ISO-8601 pairing timestamp. */
  readonly pairedAt: string;
}

/** One live addressable session, read-only projection. @public */
export interface TeammateInfoSession {
  readonly sessionId: string;
  readonly runIds: readonly string[];
  readonly task?: string;
}

/** Snapshot returned by `GET /remote/teammates`. @public */
export interface TeammateInfoSnapshot {
  readonly peers: readonly TeammateInfoPeer[];
  readonly sessions: readonly TeammateInfoSession[];
  readonly pendingAsksCount: number;
}

/**
 * D5 (ADR-ECO-112 §ZD5) ; supplies the read-only paired-peers + live-sessions
 * + pending-asks-count snapshot for a remote/phone dashboard panel. Optional:
 * absent (the default) leaves `GET /remote/teammates` 404ing exactly as a
 * server built before this option existed. @public
 */
export interface TeammateInfoPort {
  snapshot(): Promise<TeammateInfoSnapshot>;
}

export interface RemoteControlServerOptions {
  /** TCP port. Default 3113. */
  port?: number;
  /** Bind host. Default 127.0.0.1. A non-loopback host requires a token. */
  host?: string;
  /** Bearer token required on every request. */
  token?: string;
  /** HITL channel — wired to the /remote/hitl/:id routes when provided. */
  approvalChannel?: RemoteApprovalChannel;
  /**
   * Origins permitted to call this server cross-origin. The static PWA at
   * `https://preste.vauban.tech` (and `http://localhost:5180` in dev) needs
   * CORS to be allowed by the server; browsers block xhr/fetch otherwise.
   *
   * Defaults to `["https://preste.vauban.tech", "http://localhost:5180",
   * "http://localhost:5173"]`. Set to an empty array to disable CORS (only
   * same-origin clients then work — e.g. a curl on the same machine).
   *
   * Wildcard `"*"` is supported but downgrades security : Authorization
   * headers can still flow because the SDK does not opt into credentialed
   * CORS, but any page on the open web could reach the server. Use with
   * care.
   */
  allowedOrigins?: string[];
  /**
   * Durable backing store for revocations (P7). When provided, the server
   * loads existing revocations at boot and writes every new revocation
   * synchronously before responding. Survives process restarts ; closes
   * the token-replay-after-restart attack vector.
   *
   * Without persistence, revocations live only in-memory and reset on
   * restart (the documented pre-P7 behavior).
   */
  persistence?: PersistencePort;
  /**
   * Optional DPoP replay store for device-bound sub-tokens (P1b). When
   * a sub-token carries a `cnf.jkt` claim, the server requires every
   * request to carry a fresh `DPoP: <jwt>` header signed by the matching
   * private key. The replay store tracks seen `jti`s within their
   * freshness window. Defaults to an in-process `DpopReplayStore` ; pass
   * your own (Redis-backed for multi-pod) when scaling out.
   */
  dpopReplayStore?: DpopReplayStore;
  /**
   * Public-facing base URL (e.g. `https://api.example.com`) — used to
   * compute the expected `htu` for DPoP validation. When omitted, the
   * server reconstructs from request headers (`X-Forwarded-Proto` +
   * `Host`) ; suitable for direct loopback but ambiguous behind a
   * reverse proxy that rewrites paths.
   */
  publicBaseUrl?: string;
  /**
   * L3-B b2 (ADR-ECO-112) ; when provided, wires `POST /teammate/send` : a
   * dedicated route for the cross-install teammate crossing, authenticated
   * by the pinned-peer signed envelope itself (D2), NOT by this server's
   * bearer/sub-token ladder. Absent (the default): the route 404s, exactly
   * as it would on a server that predates this option.
   */
  teammateSend?: TeammateSendPort;
  /**
   * sprint-893 d1 ; when provided, wires `GET /remote/teammates` (read-only
   * scope): paired peers + live addressable sessions + pending-asks count,
   * for a remote/phone dashboard panel. Absent (the default): the route
   * 404s, exactly as it would on a server that predates this option.
   */
  teammateInfo?: TeammateInfoPort;
  /**
   * SP1 event-push ; when provided, wires `POST /teammate/events` : a session's
   * signed SessionEvents pushed to this (controller) install. Authenticated by
   * the event signature via the wired port, NOT this server's bearer ladder.
   * Absent (the default) : the route 404s.
   *
   * @experimental
   */
  teammateEventSink?: TeammateEventSinkPort;
}

/** @public */
export interface RemoteControlServerHandle {
  /** Base URL a remote client connects to. */
  readonly url: string;
  /** Stop the server and drop all SSE clients. */
  close(): Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** Read a bounded POST body; returns "" on error. */
function readBody(req: import("node:http").IncomingMessage, cap = 16_384): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > cap) req.destroy();
    });
    req.on("end", () => resolve(body));
    req.on("error", () => resolve(""));
  });
}

/**
 * Start the remote-control HTTP+SSE server over a RemoteControlPort.
 * Resolves once listening.
 * @public
 */
export async function createRemoteControlServer(
  port: RemoteControlPort,
  opts: RemoteControlServerOptions = {},
): Promise<RemoteControlServerHandle> {
  const tcpPort = opts.port ?? 3113;
  const host = opts.host ?? "127.0.0.1";
  const token = opts.token ?? "";
  const approvalChannel = opts.approvalChannel;
  const allowedOrigins = opts.allowedOrigins ?? [
    "https://preste.vauban.tech",
    "http://localhost:5180",
    "http://localhost:5173",
  ];
  const allowAllOrigins = allowedOrigins.includes("*");

  if (!LOOPBACK.has(host) && token === "") {
    throw new Error(
      "remote-control: a non-loopback host requires a token — refusing to start unauthenticated.",
    );
  }

  const sseClients = new Set<ServerResponse>();
  const persistence = opts.persistence;
  // T6f revocation — in-memory jti deny-list, optionally mirrored by the
  // configured PersistencePort (P7). On boot, we hydrate from the store
  // so revocations survive restarts ; on revoke, the in-memory write +
  // the durable write are sequenced so the operator's 200 response is
  // a real durability promise, not just an in-memory ack.
  //
  // Why fail-closed on persistence load failure : a partial deny-list is
  // a security regression. If the store cannot be read, the server must
  // refuse to start (the caller can clear persistence or restart with a
  // fresh store path).
  const revokedJtis = new Set<string>();
  if (persistence) {
    const existing = await persistence.loadRevocations();
    for (const jti of existing) revokedJtis.add(jti);
  }

  // P1b — DPoP replay store. Defaults to an in-process bounded store ;
  // host can inject its own (Redis, SQLite) for multi-pod deployments.
  const dpopStore = opts.dpopReplayStore ?? new DpopReplayStore();
  const publicBaseUrl = opts.publicBaseUrl;

  // CORS — echo the request Origin when it's in the allowlist (or when "*"
  // is configured). Without this, the static PWA at preste.vauban.tech
  // cannot fetch/EventSource against an LAN preste --remote server.
  const corsHeadersFor = (req: import("node:http").IncomingMessage): Record<string, string> => {
    const origin = req.headers.origin;
    if (!origin) return {};
    const allowed = allowAllOrigins || allowedOrigins.includes(origin) ? origin : null;
    if (!allowed) return {};
    return {
      "Access-Control-Allow-Origin": allowed,
      Vary: "Origin",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
    };
  };

  const server: Server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    // Split pathname from query string once — route matching uses `pathname`
    // (exact-match safe even with ?token= / ?since=), while the auth gate
    // still inspects the full `url` for query params.
    const qIdx = url.indexOf("?");
    const pathname = qIdx === -1 ? url : url.slice(0, qIdx);
    const method = req.method ?? "GET";
    const corsHeaders = corsHeadersFor(req);

    // Mirror CORS headers on every response by patching writeHead.
    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = ((statusCode: number, headers?: Record<string, string | string[]>) => {
      const merged = { ...corsHeaders, ...(headers ?? {}) };
      return origWriteHead(statusCode, merged);
    }) as typeof res.writeHead;

    // OPTIONS preflight — answer with the CORS headers and 204 No Content.
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Liveness probe — intentionally unauthenticated. It returns only
    // {status:"ok"}, no session data, so a client / monitor can confirm the
    // server is up before it has the token.
    if (method === "GET" && pathname === "/remote/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // POST /teammate/send ; L3-B b2, ADR-ECO-112. Deliberately handled BEFORE
    // the auth gate below, exactly like /remote/health : D2 says the pinned-peer
    // signed envelope IS the send credential, so this route must never require
    // this server's own bearer/sub-token. Absent `teammateSend` (the default) :
    // 404, byte-identical to a server built before this option existed.
    if (method === "POST" && pathname === "/teammate/send") {
      if (!opts.teammateSend) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const raw = await readBody(req, TEAMMATE_SEND_BODY_CAP);
      let envelope: unknown;
      try {
        envelope = raw ? JSON.parse(raw) : undefined;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: false, error: "malformed_json" }));
        return;
      }
      if (typeof envelope !== "object" || envelope === null) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: false, error: "malformed_envelope" }));
        return;
      }
      let outcome: TeammateSendOutcome;
      try {
        outcome = await opts.teammateSend.deliverCrossInstall(envelope);
      } catch {
        // deliverCrossInstall's contract is to resolve, never throw ; treat a
        // violation as an internal error rather than leak whatever it threw.
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: false, error: "internal_error" }));
        return;
      }
      if (outcome.accepted) {
        res.writeHead(200, { "Content-Type": "application/json" });
        // `targets` rides back ONLY for a list_targets answer ; a normal
        // ask/inform delivery omits it, byte-identical to the pre-Z-D 200 body.
        res.end(
          JSON.stringify({
            accepted: true,
            ...(outcome.targets !== undefined ? { targets: outcome.targets } : {}),
          }),
        );
        return;
      }
      const errorName = outcome.errorName ?? "rejected";
      const status = TEAMMATE_SEND_ERROR_STATUS[errorName] ?? 401;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accepted: false, error: errorName }));
      return;
    }

    // POST /teammate/events ; SP1 event-push. Handled BEFORE the auth gate,
    // exactly like /teammate/send : the signed SessionEvent is the credential.
    if (method === "POST" && pathname === "/teammate/events") {
      if (!opts.teammateEventSink) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const raw = await readBody(req, TEAMMATE_SEND_BODY_CAP);
      let event: unknown;
      try {
        event = raw ? JSON.parse(raw) : undefined;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: false, error: "malformed_json" }));
        return;
      }
      if (typeof event !== "object" || event === null) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: false, error: "malformed_event" }));
        return;
      }
      let outcome: TeammateEventPushOutcome;
      try {
        outcome = await opts.teammateEventSink.receivePushedEvent(event);
      } catch {
        // receivePushedEvent's contract is to resolve, never throw ; treat a
        // violation as an internal error rather than leak whatever it threw.
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: false, error: "internal_error" }));
        return;
      }
      if (outcome.accepted) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: true }));
        return;
      }
      const eventErrorName = outcome.errorName ?? "rejected";
      const eventStatus = TEAMMATE_SEND_ERROR_STATUS[eventErrorName] ?? 401;
      res.writeHead(eventStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accepted: false, error: eventErrorName }));
      return;
    }

    // Auth gate — every other route. When no token is configured (loopback
    // dev mode), grants "full" scope by default. Otherwise resolves the
    // presented Bearer to its effective scope (parent → full, valid
    // sub-token → its declared scope, else 401).
    //
    // The token can be presented via the Authorization: Bearer header OR
    // a ?token=<token> query string parameter. The latter is required by
    // `EventSource` (browser SSE) which CANNOT set custom headers.
    let effectiveScope: SubTokenScope;
    if (token === "") {
      effectiveScope = "full";
    } else {
      const auth = req.headers.authorization ?? "";
      const headerToken = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      let queryToken = "";
      if (!headerToken) {
        const qsMatch = url.match(/[?&]token=([^&]+)/);
        if (qsMatch?.[1]) {
          try {
            queryToken = decodeURIComponent(qsMatch[1]);
          } catch {
            queryToken = "";
          }
        }
      }
      const presented = headerToken || queryToken;
      const resolved = resolveAuthScopeInstrumented(token, presented, Date.now(), (jti) =>
        revokedJtis.has(jti),
      );
      if (!resolved) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      effectiveScope = resolved;

      // P1b — DPoP gate for device-bound sub-tokens. When the verified
      // sub-token carries a `cnf` claim, the bearer alone is not enough ;
      // the request MUST also include a fresh `DPoP: <jwt>` header signed
      // by the bound private key.
      //
      // Skip the gate when the presented token IS the parent (full scope)
      // — the parent token is owned by the founder's local process, not
      // a remote device.
      if (presented !== token) {
        const subVerification = verifySubToken(token, presented, Date.now());
        if (subVerification.valid && subVerification.cnf) {
          const dpopHeader = req.headers.dpop;
          const dpopJwt = Array.isArray(dpopHeader) ? dpopHeader[0] : dpopHeader;
          if (typeof dpopJwt !== "string" || dpopJwt === "") {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "dpop_required",
                detail: "sub-token carries cnf claim ; DPoP header required",
              }),
            );
            return;
          }
          // Reconstruct the expected htu. Prefer the configured public
          // base URL ; fall back to request headers.
          const base = publicBaseUrl
            ? publicBaseUrl.replace(/\/$/, "")
            : (() => {
                const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
                const reqHost =
                  (req.headers["x-forwarded-host"] as string | undefined) ??
                  req.headers.host ??
                  `${host}:${tcpPort}`;
                return `${proto}://${reqHost}`;
              })();
          const expectedHtu = `${base}${pathname}`;
          const dpopResult = await validateDpopProof(dpopJwt, {
            expectedJkt: subVerification.cnf.jkt,
            expectedHtm: method.toUpperCase(),
            expectedHtu,
            accessToken: presented,
            isReplayed: (jti) => dpopStore.isReplayed(jti),
            recordJti: (jti, exp) => dpopStore.record(jti, exp),
          });
          if (!dpopResult.valid) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "dpop_invalid",
                detail: dpopResult.reason,
              }),
            );
            return;
          }
        }
      }
    }

    // Per-route scope check helper.
    const requireScope = (required: SubTokenScope): boolean => {
      if (scopeCovers(effectiveScope, required)) return true;
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "forbidden",
          required,
          granted: effectiveScope,
        }),
      );
      return false;
    };

    if (method === "GET" && pathname === "/remote/state") {
      if (!requireScope("read-only")) return;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(port.state()));
      return;
    }

    // GET /remote/teammates ; sprint-893 d1, read-only teammates panel.
    if (method === "GET" && pathname === "/remote/teammates") {
      if (!requireScope("read-only")) return;
      if (!opts.teammateInfo) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const snapshot = await opts.teammateInfo.snapshot();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(snapshot));
      return;
    }

    // GET /remote/stream[?since=N] — SSE
    if (method === "GET" && pathname === "/remote/stream") {
      if (!requireScope("read-only")) return;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const sinceMatch = url.match(/[?&]since=(\d+)/);
      const since = sinceMatch ? Number.parseInt(sinceMatch[1], 10) : undefined;
      // Backfill — gap-free reconnection.
      for (const event of port.backlog(since)) {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      const unsubscribe = port.subscribe((event) => {
        try {
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        } catch {
          sseClients.delete(res);
        }
      });
      sseClients.add(res);
      req.on("close", () => {
        unsubscribe();
        sseClients.delete(res);
      });
      return;
    }

    // POST /remote/inject — {text, whisper?}
    if (method === "POST" && pathname === "/remote/inject") {
      if (!requireScope("full")) return;
      void readBody(req).then((body) => {
        let text = "";
        let whisper = false;
        let source = "remote";
        try {
          const p = body ? (JSON.parse(body) as Record<string, unknown>) : {};
          text = String(p.text ?? "");
          whisper = p.whisper === true;
          if (typeof p.source === "string") source = p.source;
        } catch {
          /* malformed body → empty text → 400 below */
        }
        if (text.trim() === "") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "text is required" }));
          return;
        }
        port.inbox.enqueue(text, source, whisper);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ queued: true, pending: port.inbox.size() }));
      });
      return;
    }

    // POST /remote/veto/:callId — {by?, reason?}  (T6a veto window)
    const vetoMatch = pathname.match(/^\/remote\/veto\/([^/]+)$/);
    if (method === "POST" && vetoMatch) {
      if (!requireScope("approve-only")) return;
      const [, callId] = vetoMatch;
      void readBody(req).then((body) => {
        let by = "remote-http";
        let reason: string | undefined;
        try {
          const p = body ? (JSON.parse(body) as Record<string, unknown>) : {};
          if (typeof p.by === "string" && p.by.trim() !== "") by = p.by;
          if (typeof p.reason === "string") reason = p.reason;
        } catch {
          /* tolerate empty/malformed body — defaults still meaningful */
        }
        port.vetoChannel.submit({
          callId: callId as string,
          by,
          ...(reason ? { reason } : {}),
          at: new Date().toISOString(),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ vetoed: true, callId }));
      });
      return;
    }

    // POST /remote/hitl/:id/approve | reject
    const hitlMatch = pathname.match(/^\/remote\/hitl\/([^/]+)\/(approve|reject)$/);
    if (method === "POST" && hitlMatch) {
      if (!requireScope("approve-only")) return;
      const [, id, kind] = hitlMatch;
      if (!approvalChannel) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no HITL channel on this session" }));
        return;
      }
      void readBody(req).then((body) => {
        let note = "";
        try {
          const p = body ? (JSON.parse(body) as Record<string, unknown>) : {};
          note = String(p.note ?? p.reason ?? "");
        } catch {
          /* empty note is fine */
        }
        const ok = approvalChannel.resolve(id, kind === "approve", "remote", note);
        res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(ok ? { id, verdict: kind } : { error: "unknown or already resolved" }),
        );
      });
      return;
    }

    // POST /remote/revoke/:jti — full-scope only (T6f revocation).
    // Adds the jti to the in-memory deny-list AND (when persistence is
    // configured, P7) writes durably before responding 200. Idempotent —
    // re-revoking is a no-op.
    const revokeMatch = pathname.match(/^\/remote\/revoke\/([A-Za-z0-9_-]+)$/);
    if (method === "POST" && revokeMatch) {
      if (!requireScope("full")) return;
      const [, jti] = revokeMatch;
      const already = revokedJtis.has(jti as string);
      revokedJtis.add(jti as string);
      // Durable write before 200. If this fails, surface the error to the
      // operator — a 200 must mean "durable" when persistence is on, else
      // a kill-restart loop would silently re-validate the token.
      if (persistence && !already) {
        try {
          await persistence.saveRevocation(jti as string);
        } catch (err) {
          revokedJtis.delete(jti as string);
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "persistence.saveRevocation failed",
              detail: err instanceof Error ? err.message : String(err),
            }),
          );
          return;
        }
      }
      // P11 — record the revocation as an OTEL span + counter.
      recordRevocation(jti as string, already);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          revoked: true,
          jti,
          alreadyRevoked: already,
          totalRevoked: revokedJtis.size,
          durable: persistence !== undefined,
        }),
      );
      return;
    }

    // GET /remote/revocations — full-scope, list current jtis (debugability).
    if (method === "GET" && pathname === "/remote/revocations") {
      if (!requireScope("full")) return;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jtis: Array.from(revokedJtis) }));
      return;
    }

    // POST /remote/bind-device — upgrade a bearer sub-token to device-bound (P1b-2).
    //
    // Input  : { jwk: EcP256Jwk } (the device's WebCrypto public key).
    // Auth   : Authorization: Bearer <existing sub-token without cnf>.
    //          Parent token rejected (the founder process is not a device).
    // Effect : mint a new sub-token with cnf.jkt = thumbprint(jwk), revoke
    //          the old jti durably (via the configured PersistencePort).
    // Output : { subToken, expiresAt, scope, oldJti, newJti }.
    if (method === "POST" && pathname === "/remote/bind-device") {
      if (token === "") {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "bind_device_requires_token",
            detail: "loopback-no-token mode cannot mint device-bound tokens",
          }),
        );
        return;
      }
      // Re-extract the presented Bearer (the auth gate consumed it but the
      // local was not lifted to this scope). Mirroring the gate's logic
      // keeps the route self-contained.
      const auth2 = req.headers.authorization ?? "";
      const presented = auth2.startsWith("Bearer ") ? auth2.slice(7) : "";
      if (presented === "" || presented === token) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "bind_device_requires_sub_token",
            detail: "parent token cannot be device-bound",
          }),
        );
        return;
      }
      const body = await readBody(req);
      let jwk: EcP256Jwk | undefined;
      try {
        const p = body ? (JSON.parse(body) as { jwk?: unknown }) : {};
        if (p && typeof p.jwk === "object" && p.jwk !== null) {
          jwk = p.jwk as EcP256Jwk;
        }
      } catch {
        /* malformed body → handled below */
      }
      if (!jwk) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "jwk required in body" }));
        return;
      }
      let result: ReturnType<typeof rebindSubToken>;
      try {
        result = rebindSubToken({
          parentToken: token,
          oldSubToken: presented,
          jwk,
        });
      } catch (err) {
        const code = (err as { code?: string }).code ?? "rebind_failed";
        const detail = err instanceof Error ? err.message : String(err);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: code, detail }));
        return;
      }
      // Atomic revocation : in-memory write, then durable write before 200.
      // On persistence failure, roll the in-memory state back — the caller
      // still has a usable bearer sub-token until they retry.
      const alreadyRevoked = revokedJtis.has(result.oldJti);
      revokedJtis.add(result.oldJti);
      if (persistence && !alreadyRevoked) {
        try {
          await persistence.saveRevocation(result.oldJti);
        } catch (err) {
          revokedJtis.delete(result.oldJti);
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "persistence.saveRevocation failed",
              detail: err instanceof Error ? err.message : String(err),
            }),
          );
          return;
        }
      }
      recordRevocation(result.oldJti, alreadyRevoked);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          subToken: result.subToken,
          expiresAt: result.expiresAt,
          scope: result.scope,
          oldJti: result.oldJti,
          newJti: result.newJti,
          durable: persistence !== undefined,
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(tcpPort, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  // Resolve the actual bound port — when `tcpPort` was 0 (test mode), the
  // OS assigns a free port and `server.address()` is the only source of truth.
  const addr = server.address();
  const boundPort = addr && typeof addr === "object" && "port" in addr ? addr.port : tcpPort;

  return {
    url: `http://${host}:${boundPort}`,
    async close(): Promise<void> {
      for (const res of sseClients) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      sseClients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
