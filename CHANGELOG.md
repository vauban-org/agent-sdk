# Changelog ; @vauban-org/agent-sdk

## 4.0.0

### Major Changes

- Extraction du moteur de grading d'assurance vers un paquet workspace interne
  jamais publié (ADR-ECO-113 A3, décision founder 2026-09-01). BREAKING :
  - le sous-chemin `@vauban-org/agent-sdk/otel/grade` est retiré de la exports
    map ;
  - `@vauban-org/agent-sdk/proof` ne re-exporte plus `ConeStep`, `Grade`,
    `StepEvidence`, `backwardCone`, `deriveConeGrade`, `deriveStepGrade`,
    `gradeRank`, `minGrade` ;
  - `emitConeResult` et `VAUBAN_CONE_ATTRIBUTE_KEYS` quittent le paquet ;
  - `OtelSpan.attributes` s'élargit à `string | number | boolean`.

  `toOtelSpan` dégrade désormais explicitement : le moteur de grading n'est
  plus référencé par ce paquet — un hôte qui le possède l'INJECTE une fois au
  bootstrap via `setAssuranceGradingEngine` (nouveau port, exporté par
  `./proof` avec le type `AssuranceGradingEngine`). Sans injection, les
  attributs `vauban.assurance.grade` / `vauban.assurance.cone_min` sont OMIS
  et le marqueur `vauban.assurance.unavailable: true` (constante
  `VAUBAN_ASSURANCE_UNAVAILABLE`, exportée par `./proof`) est posé —
  l'absence de l'outil de mesure est dite, jamais rendue comme un grade.
  Consommateurs externes : la capacité de grading n'est plus dans la surface
  publique.

## 3.6.0

### Minor Changes

- e53b122: Promote the `AdvisoryClaim` type boundary into the SDK (ADR-ECO-101 I2 GATE). A learned / predictive value (an LLM note, an ML score) enters a loop as a typed `AdvisoryClaim<T>` and is forbidden by type from reaching a gate or the A3 decision domain ; `advisoryClaim` constructs one, `isAdvisory` guards it, and `assertNotAdvisory` is the runtime defence-in-depth backstop behind the type wall. Lets any agent mix an advisory (LLM / ML) signal with a deterministic gate without the prediction contaminating the provable perimeter. L1 evidence: the BTC best-execution pilot.
- 552022b: Promote `createCostAccountingPort` into the SDK (ADR-ECO-101 W0 GATE). An `LLMProviderPort` decorator that aggregates cost / token / cache-hit / latency telemetry per OODA cycle (`metadata.correlationId`) and per worker (`metadata.agentId`), exposing a deterministic `snapshot()`. Reusable by any agent that injects an `LLMProviderPort`. L1 evidence: the BTC best-execution pilot.
- 3d80865: OODAContext now carries an optional `stepId` — the id of the `run_step` wrapping the
  currently-executing phase, injected by the OODA runtime for the duration of `phase.fn`.
  It lets a phase tie a side artifact it persists (e.g. an `agent_decision_proof` row)
  back to its own step, so an external re-execution verdict on that artifact can later
  surface on the step (RunCertificate / cone-min grade). Additive and optional —
  existing phases, harnesses, and `OODAContext` constructions are unaffected.
- bfe152d: Move the delivery-factory gate machinery into the SDK as `src/delivery/` (ADR-ECO-130 Phase 2, T2). It was living in `packages/cli`, so the usine v2 engine could not reuse it and its signed envelope carried `decisionCore.verdicts: []` ; an attestation of nothing. The module now exports the deterministic anchor registry (`ANCHOR_CHECKS`, `buildAnchorLens`), the execution grounding with its B3 commit binding (`runGroundedTests`), the content-grounded config validation (`runConfigValidation`), the adversarial and drift lenses, `runGate` / `runDriftGate`, and the zero-trust test-command allowlist (`validateTestCommand`) with its real spawn/read adapters.

  Behavior is unchanged: every moved body is token-identical to its origin, and preste's 469 delivery tests pass unmodified against the re-exports. The module frontier keeps `node:child_process` / `node:fs` in a single file (`node-exec.ts`); everything else is pure or takes its I/O injected, so the whole gate runs against deterministic mocks. `validateTestCommand` is a security allowlist over an untrusted producer-declared command and now has exactly one home ; two copies would diverge.

- 2170e83: Promote the `fanOut` / `fanInArgmin` combinators into the SDK (ADR-ECO-101 W3 / I4 GATE). `fanOut` runs an async map with bounded concurrency and keeps results in input order (never completion order), avoiding the rate-limit cascade a naive batch triggers. `fanInArgmin` is a deterministic argmin over a total order with a lexicographic tie-break on a canonical id, returning the full ranked selection trace ; a non-deterministic fan-in cannot be re-executed and contaminates an A3 re-execution grade. L1 evidence: the BTC best-execution pilot.
- b36bde0: Deprecate `PipelinesClient` / `createPipelinesClient`. The `/api/pipelines/*` HTTP API was removed from the command-center backend in sprint-623 (pipelines now run as OODA agents scheduled via GitHub Actions) and its last dead MCP callers were deleted in sprint-850. Every `PipelinesClient` method now throws the new exported `PipelineApiRemovedError` immediately instead of attempting a network call that would fail with a confusing 404/network error, and construction emits a one-time `deprecated()` warning via the SDK's shared deprecation helper. There is no HTTP-client replacement — the export is kept for source compatibility only and will be removed in a future major version.
- 566fc48: grade: add `StepEvidence.external_verifier_grade` — the only entry to A2/A3. An
  independent external verifier (producer ≠ verifier) writes a re-execution verdict;
  self-produced evidence still caps at A1, and an external A0 floors the step.
  Additive and backward-compatible (existing A0/A1 derivation unchanged).
- 2a04a8c: rigor-score (wave-2 MOVE#9, `@experimental`): deterministic, zero-LLM RigorBench-inspired
  (arXiv:2606.22678) process-discipline scoring for a single agent turn. Honestly scores 3 of
  RigorBench's published 5 pillars from a turn's own already-observed data ; Verification
  Coverage (`evidenceCount/(evidenceCount+gapCount)`), Recovery Efficiency (loop-freedom +
  error-recovery over the turn's tool calls), Atomic Transition Integrity (read-before-edit +
  ended-clean) ; renormalized to sum to 1 (VC 0.3846 / RE 0.3846 / ATI 0.2308). Planning
  Fidelity and Abstention Quality are deliberately NOT scored (no honest proxy in a plain CLI
  turn); every `RigorScoreResult` carries `pillarsScored`/`pillarsTotal` so a consumer can never
  present the composite as a bare number. New subpath `@vauban-org/agent-sdk/rigor-score` +
  root barrel re-export (`scoreRigor`, the 3 pillar functions, weights, and types).
- 2170e83: Promote `RunStatePort` + its three trace projections into the SDK (ADR-ECO-101 W2 GATE). `RunStatePort` (`inMemoryRunState`) is a thin read/fork VIEW over the immutable `TraceStep` chain ; a fork mints a new prefix and never mutates the parent. The projections are pure functions of the trace: `traceToMermaid` (graph-viz), `findBreakpoint` (breakpoint), `injectAt` (state-injection, fork-not-mutate). Graph-viz, breakpoint, state-injection and time-travel are one immutable trace seen four ways, not four state models. L1 evidence: the BTC best-execution pilot.

### Patch Changes

- d68df57: Fix the `validateTestCommand` parser and widen its allowlist to the static checkers a TypeScript repo gates on.

  The parser scanned EVERY token against the arbitrary-package verb set, so it could not tell a subcommand from a flag's value and refused `pnpm test --filter x` ; the exact form its own documentation gave as compliant. A verb is now only read in subcommand position; a code-exec flag is still refused wherever it appears. The same pass compares flag NAMES, so the joined form (`--eval=payload`, `make --file=/tmp/Makefile`) can no longer slip past a check written for the split form ; that was a live bypass of the code-exec and worktree-escape guards.

  `tsc` and `biome` join the allowlist, so `ci-green` on a TypeScript repo can rest on a typecheck and a build instead of the suite alone. Both READ the project rather than execute it: the `tsc` CLI runs no project code (`plugins` are language-service only, and custom transformers need another binary), and biome is a self-contained Rust binary with no JavaScript config or plugin loading. `eslint` is deliberately NOT allowed, because `eslint.config.js` is JavaScript executed at load. Each entry is bounded: `tsc` refuses `--project`/`--build`/`--watch` and any positional (`tsc file.ts` bypasses `tsconfig.json` and checks under non-strict defaults); `biome` is limited to `check`/`lint`/`ci` and refuses `--write`/`--fix`/`--unsafe` (a checker that repairs what it measures manufactures its own green) and `--config-path`; neither may be aimed at a path leaving the worktree.

  `TEST_SURFACE_PATTERNS` (usine-engine `verify`) gains `tsconfig*.json` and `biome.json(c)`: once a typecheck is an anchor, flipping `"strict": false` moves the oracle exactly like a `vitest.config` exclude, and the command string itself is already frozen. The 192 existing `packages/cli` gate-runner tests pass unmodified.

## [3.5.0] ; 2026-07-08

### Added

- **`run-memory` module (ADR-ECO-117, tier O `@experimental`) ; the governed retrieval-grounded agent-loop primitive.** `RunJournalPort` + `FileRunJournal` (over the trajectory NDJSON), a non-destructive `Compactor` (window-as-cache with a deterministic no-LLM fallback), the `recall` tool, and `CompositeRunJournal` (fail-soft Brain EM mirror). Wires into `AgentLoop` via an opt-in `runMemory` seam (journal-first: every step journaled before any eviction ; absent = byte-identical legacy behavior). Replaces the fixed step cap with model-driven termination + journal-first compaction + recall. L1 evidence: 7009 tests green, live A/B grounded 2/2 complete vs capped 0/2 budget_exhausted (sprint-935).

## [3.4.0] ; 2026-07-06

### Added

- **V12 4-plane memory wiring for the OODA cycle (sprint-895, ADR-ECO-114).** `BrainPort` gains three optional planes alongside the existing semantic tier: `working` (`WorkingMemoryPort` ; set/get/delete/list, TTL + pin, mirrors `working_memory_*`), `episodic` (`EpisodicMemoryPort` ; append/query, mirrors `episodic_append`/`episodic_query`), and `claims` (`ClaimPort` ; assert/query verifiable subject/predicate/object triples, mirrors `claim_assert`/`claim_query`). All three are additive and feature-detected: a host that omits a plane sees no behavior change.
- **`createHttpBrainAdapter`** wires all three new planes to the deployed Brain V12 REST surface (`/api/memory/working`, `/api/memory/episodic`, `/api/memory/claims`), each independently feature-detected against the live schema.
- **`withBrainContext` (orient-phase wrapper)** now loads the WM goal slot and a recent EM window at cycle start and folds them into `OrientInputWithBrain`, alongside the existing semantic recall chunks, in a single `<memory_context>` block.
- **OODA cycle loop** pins a private run-goal WM slot at cycle start, journals observation/decision/error events to EM via the shared `publishEpisodicEvent` helper (`constitution/signal.ts`), and asserts a Claim for a verifiable (non-pending) outcome. Every write is fail-soft: a plane write failure logs a warning and never aborts the cycle.

## 3.1.0

### Minor Changes

- 3f91959: Add `x_tweet_metrics` skill: fetch X API v2 public_metrics + non_public_metrics for a given tweet_id. Returns likes/retweets/replies/impressions/bookmarks/quotes. Bearer auth via X_BEARER_TOKEN env. Falls back to public_metrics only on 403 (non_public_metrics requires user context).

  Consumer: forge-29-engagement-analyst post-publish metrics enrichment (V2 W5-B).

### Patch Changes

- 85b3562: XPublisher.publish() now forwards `payload.reply_to_id` to the internal `postTweet(cfg, text, replyToId)`. Previously the reply_to_id was extracted nowhere, so threads created as replies posted as top-level tweets.

  Forge consumer: 28-reply-strategist already creates `kind=tell` tasks with `payload.reply_to_id`; Platform Dispatcher (forge:shared/tell-task/phases.ts) calls `publishers.publish()` which now correctly threads the reply.

## [3.0.1] ; 2026-05-25

### Bug Fixes

- **XPublisher**: `publish()` now forwards `payload.reply_to_id` (string | undefined)
  to `postTweet()` as `in_reply_to_tweet_id`. Previously the root tweet was always
  posted standalone even when a reply target was specified ; Forge 28-reply-strategist
  tell-tasks with `payload.reply_to_id` are now handled correctly.

## [3.0.0] ; 2026-05-24

### Breaking Changes

- **Legacy AG-UI event name aliases removed.** `eventNaming: "legacy"` is no longer a valid
  option on `RemoteControlHubOptions`; the field has been deleted from the type. All consumers
  must use canonical UPPER_SNAKE_CASE event types (`RUN_STARTED`, `TEXT_MESSAGE_CONTENT`, etc.).
  See [docs/migrations/agent-sdk-2-to-3.md](../../docs/migrations/agent-sdk-2-to-3.md) for the migration guide.
- **Removed exports:** `LEGACY_TO_CANONICAL`, `CANONICAL_TO_LEGACY`, `normalizeEventType`,
  `EventNamingMode`. Use `toCanonicalEventType(type)` for the emit-boundary translation.
- **Hub now normalises type BEFORE signing.** Verifiers always receive canonical-typed signed
  events. Signed archives produced by 2.x with `eventNaming: "legacy"` are verified against
  the legacy-typed bytes; use `verifyEvent` with the matching vocabulary.

### Added

- **T6h closure: durable `OutgoingMessageStore` for relay sends.** `sendToGuest()` in
  `relay-client.ts` now persists outgoing frames to SQLite (`OutgoingMessageStore`) when
  the socket is unavailable or the send throws. The queue is drained in FIFO order on
  reconnect (`joined` SSE event). Frames are retried up to `MAX_OUTGOING_ATTEMPTS` (10)
  and then dropped with a logged error. The store is injectable via
  `ConnectRelayOptions.outgoingStore` for testing; the default path follows the
  `PRESTE_HOME` convention (`~/.preste/outgoing.sqlite`).
- **PayPort + StarknetSepoliaPayAdapter (Sepolia POC).** Chain-agnostic payment port (`PayPort`, `PayRequest`, `PayResult`) per ADR-ECO-031 VPSF chain-agnostic invariant. First adapter ships a Starknet Sepolia STRK transfer using ERC-20 `transfer(recipient, amount: u256)`. Self-hosted RPC via vauban-infrastructure (`https://sepolia.rpc.vauban.tech/rpc/v0_10`) ; SaaS RPC providers (Infura/Alchemy/Blast/QuickNode/…) rejected at construction. Mainnet refused at the adapter boundary until Phase 4. Tier-1 secret discipline : `senderPrivateKey` is never logged, persisted, or echoed in any error message. Wired through `@vauban-org/preste pay --to --amount --token STRK --network sepolia` (sprint-754).

## 2.29.0

### Deprecated

- **`eventNaming: "legacy"` is deprecated and will be removed in 3.0.0.** `createRemoteControlHub({ eventNaming: "legacy" })` now emits a one-shot `console.warn` per process pointing consumers at the canonical (default) vocabulary and the `docs/migrations/agent-sdk-2-to-3.md` migration guide. Runtime behaviour is otherwise unchanged ; legacy inputs still translate via `LEGACY_TO_CANONICAL` and the legacy vocabulary still ships on the wire when opted-in. The next major (3.0.0) removes the `"legacy"` value from the `EventNamingMode` union and deletes the alias map entirely.

### Roadmap (cutover plan, continued from 2.28.0)

| Version    | Default        | Legacy on input                    | Legacy on output                       |
| ---------- | -------------- | ---------------------------------- | -------------------------------------- |
| 2.27.0     | legacy         | accepted                           | emitted (default)                      |
| 2.28.0     | canonical      | accepted                           | opt-in via `eventNaming: "legacy"`     |
| **2.29.0** | **canonical**  | **accepted (deprecation warning)** | **opt-in via `eventNaming: "legacy"`** |
| 3.0.0      | canonical only | rejected at the type level         | removed                                |

## 2.28.1

### Patch Changes

- 741756d: fix(marketing): raise X_THREAD_MAX_ENTRIES from 6 to 10 to align with outreach-writer prompt intent

  The outreach-writer prompt at forge/src/agents/19-outreach-writer/content-generator.ts:143
  explicitly requests 8-10 tweets ("Not 6."). The old cap of 6 caused 100% of thread drafts to
  fail the gate, resulting in zero content published in prod (logged as "marketing gate failed;
  skipping createInitiativeTask").

## [2.28.0] ; 2026-05-23

### Changed (breaking for consumers depending on default behavior)

- **`eventNaming` default is now `"canonical"`.** `createRemoteControlHub()` (no explicit option) now emits AG-UI canonical UPPER_SNAKE_CASE event types (`RUN_STARTED`, `TEXT_MESSAGE_CONTENT`, `RUN_FINISHED`, `TOOL_CALL_START`, etc.) instead of the legacy dotted-lowercase types (`run.start`, `assistant.delta`, etc.). Consumers that depended on the legacy default ; preste-pwa wire reader, dashboard SSE consumer, gateway render, signed-event verification flows pre-2.28.0 ; MUST now pass `eventNaming: "legacy"` explicitly.
- Vauban extensions without AG-UI peer (`tool.intent`, `hitl.request`, `hitl.resolved`, `instruction.injected`) are now projected onto `CUSTOM_*` in the default emit path. Round-tripping `LEGACY_TO_CANONICAL → CANONICAL_TO_LEGACY` remains lossless.
- The CLI (`@vauban-org/preste`, `preste --remote` host) pins `eventNaming: "legacy"` explicitly so PWA and dashboard wire contracts remain unchanged until they ship canonical-aware readers in the next milestone.

### Roadmap (cutover plan, continued from 2.27.0)

| Version    | Default        | Legacy on input                   | Legacy on output                       |
| ---------- | -------------- | --------------------------------- | -------------------------------------- |
| 2.27.0     | legacy         | accepted                          | emitted (default)                      |
| **2.28.0** | **canonical**  | **accepted**                      | **opt-in via `eventNaming: "legacy"`** |
| 2.29.0     | canonical      | accepted with deprecation warning | removed                                |
| 3.0.0      | canonical only | rejected                          | removed                                |

### Migration

Hub call sites that previously relied on the implicit legacy default :

```ts
// Before 2.28.0 ; implicit legacy default
const hub = createRemoteControlHub();

// After 2.28.0 ; opt back into legacy explicitly to preserve wire shape
const hub = createRemoteControlHub({ eventNaming: "legacy" });

// Or accept the canonical default (recommended for new code)
const hub = createRemoteControlHub(); // canonical
const hub = createRemoteControlHub({ eventNaming: "canonical" }); // equivalent, explicit
```

## [2.27.0] ; 2026-05-23

### Added

- **Dual-emission AG-UI canonical event names.** `createRemoteControlHub({ eventNaming: "canonical" })` now emits events under the Linux Foundation AG-UI vocabulary (`RUN_STARTED`, `TEXT_MESSAGE_CONTENT`, `RUN_FINISHED`, `TOOL_CALL_START`, etc.) instead of the legacy dotted-lowercase types (`run.start`, `assistant.delta`, `run.finished`, `tool.call.start`). Default remains `"legacy"` so every existing consumer (preste-pwa, dashboard, Forge, CLI, relay) keeps working unchanged.
- **`remote/event-name-map.ts`** as the bidirectional SSOT of the canonical bridge : `LEGACY_TO_CANONICAL`, `CANONICAL_TO_LEGACY`, `ALL_KNOWN_EVENT_TYPES`, `isKnownEventType(name)`, `normalizeEventType(name, mode)`. The hub calls `normalizeEventType()` at the emit boundary so no consumer-side translation is required.
- **`looksLikeSessionEvent(input)`** runtime guard accepts BOTH vocabularies on input ; use it in relay / dashboard / PWA handlers that must tolerate a server emitting legacy OR canonical types.
- **`CUSTOM_*` projection** for Vauban-specific extensions with no AG-UI peer (`tool.intent`, `hitl.request`, `hitl.resolved`, `instruction.injected`) ; round-tripping `LEGACY_TO_CANONICAL → CANONICAL_TO_LEGACY` is lossless.
- Conformance canary closure : a new CANONICAL describe block in `@vauban-org/agent-sdk-conformance`'s `tests/reference-server.test.ts` boots the hub with `eventNaming: "canonical"` and verifies `events.type_in_vocabulary` PASSES. The legacy canary remains as the regression guard for the default mode.

### Roadmap (cutover plan)

| Version | Default        | Legacy on input                   | Legacy on output                   |
| ------- | -------------- | --------------------------------- | ---------------------------------- |
| 2.27.0  | legacy         | accepted                          | emitted (default)                  |
| 2.28.0  | **canonical**  | accepted                          | opt-in via `eventNaming: "legacy"` |
| 2.29.0  | canonical      | accepted with deprecation warning | removed                            |
| 3.0.0   | canonical only | rejected                          | removed                            |

### Tests

- SDK : 6088 pass (+56).
- Conformance : 60 pass (+2).

## [2.26.0] ; 2026-05-23

### Added

- **`rebindSubToken({ parentToken, oldSubToken, jwk })`** upgrades a bearer sub-token to device-bound. Verifies the HMAC, rejects parent tokens, rejects already-bound sub-tokens, validates the EC P-256 JWK (must not carry the private scalar `d`), and mints a new sub-token with `cnf.jkt = thumbprint(jwk)`. Inherits scope + remaining TTL. Returns `{ subToken, expiresAt, scope, oldJti, newJti }` so the caller can revoke the old jti.
- **`POST /remote/bind-device`** route shipped by `createRemoteControlServer`. Orchestrates the rebind end-to-end : verifies the bearer, mints the device-bound replacement, revokes the old jti via the configured `PersistencePort` BEFORE returning 200. On persistence failure, the old token stays valid (caller can retry).
- Exports `RebindSubTokenOptions`, `RebindSubTokenResult` from `@vauban-org/agent-sdk/remote`.
- PWA consumer (P1b-2) at `preste.vauban.tech` wires the full handshake : generates a non-extractable ECDSA P-256 keypair in IndexedDB on first launch, POSTs to `/remote/bind-device` with the public JWK, then signs a fresh DPoP proof on every subsequent `/remote/*` request. Stolen sub-token alone (QR clipboard, screen capture) is useless without the matching device key.
- Graceful degradation : server pre-2.26 (no route) → 404 → PWA falls back to bearer mode with a banner ; bearer is the parent token → 403 ; sub-token already bound → 400 `already_bound` → PWA keeps using the existing key.

### Tests

- SDK : 6032 pass (+72).
- PWA : full E2E coverage of the bind handshake + graceful degradation paths.

## [2.4.0] — 2026-05-21

### Added

- `createBrainCompactionLlmFn(semanticMemory, localLlmFn, sessionTag)` — wraps CompactionLLMFn to archive summaries to Brain (SemanticMemoryPort) fail-soft after each compact()
- `restoreSessionContext(semanticMemory, sessionTag, limit?)` — queries Brain for prior session compaction summaries, returns formatted string for system prompt injection
- Both exported from `@vauban-org/agent-sdk` (Brain-optional: pass InMemorySemanticMemory to test without Brain)

## [2.3.0] — 2026-05-21

### Added

- `ConversationContext` — tiered memory class for multi-turn agent sessions
  - Working memory: last N turns verbatim (configurable `workingMemorySize`, default 6)
  - Episodic memory: older turns as LLM-generated `CompactionSummary`
  - `toMessages(strategy)`: string suffix for minimal/ooda, `LLMMessage[]` for react/plan, `[]` for one-shot
  - `compact(llmFn)` / `maybeCompact(model, llmFn, threshold)`: context-window-aware auto-compaction
  - `toJSON()` / `fromJSON()`: snapshot serialization with version guard
  - Brain-optional by design: `CompactionLLMFn` is a pure callback, no Brain MCP dependency
- Exported types: `Turn`, `CompactionSummary`, `CompactionReport`, `ConversationContextSnapshot`, `LLMMessage`, `CompactionLLMFn`, `CompactOpts`, `ConversationContextOpts`

## 2.0.0 ; Unified Agent runtime with strategy plugins

### BREAKING CHANGES

- **`OODAAgent` renamed to `Agent`.** The old name is re-exported as
  `@deprecated` and will be removed in 3.0.
- **`createOODAAgent` renamed to `createAgent`.** Same deprecation path.
- **`OODAAgentConfig` renamed to `AgentConfig`.** Same deprecation path.
- **`OODAAgentDeps` renamed to `AgentDeps`.** Same deprecation path.

### Features

- **Unified Agent runtime with strategy plugins.** The `Agent` class now
  accepts a `strategy` config field:
  - `"ooda"` (default ; identical to 1.x `OODAAgent` behavior)
  - `"react"` ; Thought/Action/Observation text protocol
  - `"plan"` ; Plan-then-Execute
  - `"one-shot"` ; single LLM call, no tool loop
- All hooks (`skillCapture`, `onStep`, HITL approval, attestation) now
  work uniformly across all strategies (previously OODA-only).
- ReAct and Plan strategies relocated from `@vauban-org/preste`'s standalone
  loops into the SDK as first-class strategy modules. Same fallback parsing
  (ReAct JSON `tool_call` detection) preserved.
- `AgentLoop` becomes a thin shim around `Agent` with `strategy: "ooda"`,
  preserved verbatim for backward compat. Marked `@deprecated`.
- Strategy implementations live in
  `packages/agent-sdk/src/strategies/{ooda,react,plan,one-shot}.ts`.
  Each strategy implements the `AgentStrategy` interface with a single
  `run(ctx)` method. Hooks are orchestrated by the `Agent` class.

### Migration

| Was                                                      | Now                                                  |
| -------------------------------------------------------- | ---------------------------------------------------- |
| `import { OODAAgent } from "@vauban-org/agent-sdk"`      | `import { Agent } from "@vauban-org/agent-sdk"`      |
| `import type { OODAAgent } from "@vauban-org/agent-sdk"` | `import type { Agent } from "@vauban-org/agent-sdk"` |
| `new OODAAgent(cfg)`                                     | `new Agent(cfg)` or `createAgent(cfg)`               |
| `createOODAAgent(cfg)`                                   | `createAgent(cfg)`                                   |
| `import { AgentLoop } from "@vauban-org/agent-sdk"`      | Still works (shim). Prefer `Agent` for new code.     |
| `OODAAgentConfig`                                        | `AgentConfig`                                        |
| `OODAAgentDeps`                                          | `AgentDeps`                                          |

Deprecated symbols print a `console.warn` on first import in 2.x dev
builds (`NODE_ENV !== "production"`). Removed entirely in 3.0.

See `UPGRADE.md` for mechanical migration steps and per-consumer notes.

---

## 2.1.0 ; LinkedInPublisher (2026-05-20)

### Added

- **`LinkedInPublisher`** ; LinkedIn API v2 UGC Posts publisher. Auth via Bearer
  token (`LINKEDIN_ACCESS_TOKEN` env var) and author URN (`LINKEDIN_AUTHOR_URN`
  env var). Enforces the 3000-char platform limit. HTTP 401 throws immediately
  (no retry); 429 retries up to 3x with exponential backoff; 5xx throws with
  body. Returns `posted_url` derived from the `X-RestLi-Id` response header.
  Exported from `@vauban-org/agent-sdk/publishers`. Wired into
  `createPublisherRegistry({ linkedin })`.

### Usage

```ts
import { LinkedInPublisher } from "@vauban-org/agent-sdk/publishers";

const pub = new LinkedInPublisher();
// LINKEDIN_ACCESS_TOKEN + LINKEDIN_AUTHOR_URN resolved from env.
await pub.publish({
  payload: { text: "Changelog post content." },
  context: { campaignSlug: "release-broadcaster", actionId: "abc123" },
});
```

---

## 1.15.1 ; Declare missing subpath exports (2026-05-20)

### Fixed

- **`./publishers` subpath** added to `package.json` exports. `import { XPublisher } from '@vauban-org/agent-sdk/publishers'` and all other publisher adapters (EmailPublisher, DiscordPublisher, GitHubPublisher, RempartPublisher, createPublisherRegistry) now resolve correctly. The implementation files existed in `dist/publishers/` since 1.15.0 but the subpath was never declared.
- **`./marketing` subpath** added to `package.json` exports. `import { evaluateQualityGate } from '@vauban-org/agent-sdk/marketing'` now resolves correctly. Same issue: `dist/marketing/` existed but the subpath was undeclared.

Both subpaths ship the published `dist/` output without any source changes.

## 1.15.0 ; Marketing quality gate + PublisherPort (2026-05-20)

### Added

- **`@vauban-org/agent-sdk/marketing/quality-gate`** ; pure function
  `evaluateQualityGate(input)` that consumes the agent persona as the SINGLE
  source of content-policy rules and the payload as the subject under review.
  `persona.forbidden_patterns[]` compiles to RegExp and matches against text
  fields ; matches surface as violations. `persona.directives.must_not[]`
  surfaces as warnings via case-insensitive substring match. Structural
  per-platform shape rules (X tweet 280-char max, X thread 1-6 entries,
  LinkedIn body 1200-1300 chars) remain hard-coded in the gate ; they
  describe SHAPE not CONTENT and are not persona-owned.
- **`@vauban-org/agent-sdk/publishers`** ; `PublisherPort` interface +
  5 concrete adapters (XPublisher, EmailPublisher, DiscordPublisher,
  GitHubPublisher, RempartPublisher) promoted from Forge-local skills.
  Every publisher returns a uniform `PublishResult` ; the orchestrator
  dispatches by `payload.platform` or `action_type` via
  `createPublisherRegistry({ x, email, discord, github, rempart, linkedin?, extras? })`.
- **X thread duplicate-content guard** preserved in XPublisher : 30-90s
  jittered sleep before each reply, retry-once with 120-180s sleep on
  duplicate 403/422, surface `partial_failure_tweets` (1-based indexes)
  when retry also fails. Brain follow-up d8df4ed7 ; campaign
  `vauban-zkpay-starknet-launch` 2026-05-20 incident.
- **Email Message-ID + mailto: publish_evidence** preserved in EmailPublisher
  per Brain pattern f15a286d.
- **RempartPublisher.mcpCaller** ; transport-agnostic Rempart adapter that
  takes a generic MCP caller in its constructor so consumers wire their own
  client (Forge has a Rempart MCP wrapper ; Preste has its own).

### Rationale

Brain entry d8df4ed7 follow-up #1 ; marketing rules were hard-coded
duplicates across Forge (35-campaign-orchestrator + 37-marketing-content).
Each new persona could not customize its own forbidden patterns without
forking the gate. SDK 1.12 had already typed the persona's
`forbidden_patterns[]` + `directives.must_not[]` ; the gate now delegates
to those fields instead of hard-coding them.

Brain entry d8df4ed7 follow-up #2 ; the X + Email + Discord + GitHub
publishers were Forge-local skills. Preste needs the same publishers to
ship its content pipeline ; promoting them to the SDK as `PublisherPort`
removes duplicate transport code from each consumer.

### Compatibility

Fully additive. SDK 1.14 callers continue to work unchanged. The new
`./marketing` and `./publishers` subpath exports are opt-in.

## 1.14.0 ; CitadelCampaignPort scheduled_before + typed updateAction (2026-05-20)

### Added

- **`ActionFilter.scheduled_before`** ; optional `Date | string` filter forwarded
  server-side to MCP `get_campaign_actions` (Citadel supports it since commit
  44391dc, sprint S3). Replaces the Forge client-side filter pattern. Date inputs
  are serialized to RFC3339 ISO string ; pre-formatted strings pass through
  as-is. Brain follow-up entry d8df4ed7 #5.
- **`CitadelCampaignPort.updateAction(ref, patch, ctx)`** ; typed partial-update
  method that promotes the Forge-local shim to the port. ref format is the same
  compound `"<campaign_slug>/<action_id>"` used by claim/complete/block.
  CampaignActionPatch fields: `payload`, `status`, `notes`, `publish_evidence`,
  `scheduled_at`, `phase`. Only provided fields are forwarded to MCP
  `update_campaign_action`.
- **`CampaignActionPatch`** type ; exported for callers building partial updates.
- **`CampaignPatch`** type ; exported for callers building campaign partial
  updates. Adds optional `cadence_plan` field for multi-phase scheduled campaigns.

### Changed

- `createCitadelCampaignMcpAdapter` `listActions` builds tool args conditionally
  ; `scheduled_before` is only sent when the filter is set (no nil pollution on
  the MCP call surface).

### Compatibility

Fully backwards-compatible. SDK 1.13 callers that omit `scheduled_before` keep
the same MCP call shape. The new `updateAction` method is additive on the port.
In-memory contract reference implementation updated accordingly. Existing
adapter + contract tests pass unchanged.

### Rationale

Forge orchestrator was doing client-side filtering on `scheduled_at` because the
SDK 1.13 adapter only forwarded `status` to MCP. Sprint S3 wants server-side
filtering for scale (campaign actions table > 10k rows expected within 30
days). The Citadel REST/MCP surface already accepts the filter ; only the SDK
adapter needed to forward it. The Forge-local `updateAction` shim was a typed
gap that prevented Preste and other SDK consumers from using the same pattern.

## 1.12.0 — AgentPersona marketing-grade additive extension (2026-05-20)

### Added

- **`AgentPersona.directives`** — optional `{ must?: string[], must_not?: string[] }`
  for explicit MUST / MUST NOT rules surfaced in the persona prompt block as bullets.
- **`AgentPersona.forbidden_patterns`** — optional array of `{ name, pattern, scope? }`
  describing content the agent must NEVER emit. Rendered as a "Forbidden patterns"
  section in the prompt. Use case: IP leak prevention on public marketing surfaces
  (contract addresses, audit firm names pre-engagement, internal commit shas).
- **`AgentPersona.whitelist`** — optional `{ hashtags?: string[], mentions?: string[] }`
  bounding the social handles + hashtags the agent may emit. Use case: marketing
  personas restricted to real verified handles only.
- **`AgentPersona.examples`** — optional array of `{ situation, bad?, good? }` BAD vs
  GOOD teaching pairs rendered as "Examples" section. Use case: tone-of-voice training
  by contrast.
- **`AgentPersona.output_contracts`** — optional record keyed by action_type with
  `{ description?, schema_hint? }` describing the expected output shape per action.
  Use case: per-action JSON shape guidance (publish_social_post X vs publish_article).
- **`AgentPersona.extra_instructions`** — optional markdown overflow appended last,
  for content too long to encode as bullets (max 16 KB).

### Changed

- `buildPersonaPromptBlock` extended to render the new sections after the core block
  and before the end marker. Section order is stable: directives MUST, directives MUST
  NOT, whitelist, forbidden_patterns, output_contracts, examples, extra_instructions.
- `mergePersona` extended: directives merge field-by-field, arrays replace, whitelist
  merges field-by-field, output_contracts shallow-merges by key (local wins).

### Compatibility

Fully backwards-compatible — all new fields are optional. Personas without any new
field render exactly as in 1.11.x. Existing tests pass unchanged (72/72).

### Rationale

Marketing-grade personas need IP discipline + handle whitelists + per-action output
contracts that the minimal 1.11.x schema could not type. Additive evolution preserves
the "intentionally minimal" doctrine of the schema while making richer policy
first-class typed fields instead of free-text appendices.

## 1.11.1 — Export createCitadelCampaignMcpAdapter (2026-05-18)

### Fixed

- Re-export `createCitadelCampaignMcpAdapter` + `CitadelCampaignMcpClient` type
  from the top-level index. 1.11.0 only exposed the port types — consumers had
  to import from `dist/adapters/citadel-campaign-mcp.js` with `@ts-ignore`.

## 1.11.0 — Campaign Orchestrator port + Brain post-mortem helpers (2026-05-18)

### Added

- **`CitadelCampaignPort`** — host adapter interface for cross-Vauban campaign management.
  Defines `createCampaign`, `getCampaign`, `updateCampaignStatus`, `createAction`,
  `listActions`, `claimAction` (atomic, returns null on race lost), `completeAction`,
  `blockAction`, `upsertContact`, `findContactByEmail`, `updateContactStatus`,
  `bumpEngagementScore`. Discriminated `CampaignActionType` enum for worker dispatch:
  `publish_article | publish_social_post | send_cold_mail | send_follow_up_mail |
engage_target | manual_review`. Contract tests with in-memory reference impl
  in `src/ports/citadel-campaign.contract.test.ts`.
- **`createCitadelCampaignMcpAdapter(client)`** — MCP-backed implementation of
  `CitadelCampaignPort`. Maps each method to its Citadel MCP tool counterpart.
- **`BrainPort.archivePostmortem`** + **`BrainPort.archiveLesson`** (both optional)
  with `PostmortemInput` + `LessonInput` types. Backed by reserved Brain
  categories `vauban_postmortem` and `vauban_lesson` in HTTP adapter.
- **`createHttpBrainAdapter(opts)`** — HTTP BrainPort adapter with post-mortem
  helpers wired to reserved categories.

### Why

Shipped to enable Forge `35-campaign-orchestrator` agent + cross-Vauban campaign SSOT
in Citadel per spec `forge/docs/superpowers/specs/2026-05-18-campaign-orchestrator-design.md`.
Supersedes the static-brief `published: boolean` approach (was broken in production —
Glacis campaign 0/4 articles published despite being active for 4 days).

## 1.10.0 — `reactLoop.finalizeAsTool` (Brief #6) (2026-05-18)

### Added

- **`ReactLoopOptions.finalizeAsTool?: boolean`** (default `false`) —
  when `true`, the `finalize` action emitted by the LLM is treated as a
  real tool : `executeTool({ tool: "finalize", args })` is invoked, and
  its return value becomes `result.answer`. Lets callers hang
  side-effects off finalization (logging, schema validation, persistence,
  attestation) without an out-of-band adapter.
- **`ReactLoopOptions.finalizeToolName?: string`** (default `"finalize"`)
  — for callers preferring `return_final`, `submit`, etc.
- Edge case : `finalizeAsTool: true` + LLM emits `isFinal: true` without
  a matching finalize tool call → loop emits `logger.warn` and falls
  back to the legacy short-circuit (LLM `content` becomes the answer)
  rather than throwing. A misbehaving LLM does not crash the loop.

### Why (Brief #6, forge LLM 2026-05-17)

Pre-1.10.0 the loop short-circuited on `isFinal: true` and never called
`executeTool` for the finalize action. Forge's sentinel migration
adapter (`callLlmToLLMReactFn`) handled this fine for text-only
protocols, but agents wanting `finalize` to be a real tool (attach
metadata, validate the final answer via a tool, log to Brain, etc.)
had no clean path. `finalizeAsTool: true` unlocks that pattern while
keeping 1.9 behaviour byte-equivalent when the option is `undefined`
or `false`.

### Migration

```ts
// 1.9 (still works — short-circuits, no executeTool call on finalize)
await reactLoop({ /* ... */ });

// 1.10 — make finalize a real tool with side-effects
await reactLoop({
  finalizeAsTool: true,
  executeTool: async (call) => {
    if (call.tool === "finalize") {
      // schema-validate, persist, anchor, … then return the final answer
      const validated = MyAnswerSchema.parse(call.args);
      await brain.archive({ answer: validated, … });
      return JSON.stringify(validated);
    }
    return regularToolExecutor(call);
  },
});
```

`forge` continues to use the existing adapter — Brief #6 is a clean
opt-in for new agents.

## 1.9.0 — promote `buildAlertDigest()` helper from forge (2026-05-17)

### Added

- **`buildAlertDigest(items, opts?)`** — pure adaptive notification batching.
  Promoted from forge's `src/agents/23-security-auditor/agent.ts`
  `buildEscalationMessages()` after a 47-alert Telegram flood during the
  first Dependabot-enabled cycle (2026-05-17). Behaviour:
  - `0` items → `[]` (no message at all)
  - `1..threshold` items (default `3`) → one full-detail message per item
  - more than threshold → one severity-sorted digest, capped at `maxChars`
    (default `4000` chars — Telegram-safe), with `"… +K more"` truncation
    footer + optional `detailsPointer` line.
- Generalized over forge's hardcoded version: configurable `label`,
  `threshold`, `maxChars`, `detailsPointer`, `severityOrder`, `emojiMap`.
  Severities outside `severityOrder` are appended last with fallback emoji
  `"•"`. Header counts only non-zero severities.
- New public types: `AlertItem`, `AlertDigestOptions`.
- Re-exported from SDK root and from new `./alerts/` subpath.

### Migration (forge — security-auditor and 4+ other agents)

```ts
// before (forge-local)
import { buildEscalationMessages } from "../23-security-auditor/agent.js";
const messages = buildEscalationMessages(notifiable);

// after (SDK)
import { buildAlertDigest } from "@vauban-org/agent-sdk";
const messages = buildAlertDigest(notifiable, {
  label: "SECURITY",
  detailsPointer: "query Brain category=forge_alert tag=security,escalation",
});
```

Apply the same pattern in devops, finance, devrel, inbox-monitor agents to
prevent burst floods on bulk alert events.

## 1.8.0 — promote `computeQuality()` helper from forge (2026-05-17)

### Added

- **`computeQuality(inputs)`** — pure 0..1 quality score from agent feedback
  signals. Promoted verbatim from forge's `src/agents/shared/quality-scoring.ts`
  (prod-validated on 33 forge agents per ADR-ECO-039). Default `0.5` neutral,
  signals nudge up (postsPublished +0.2, threatsBlocked +0.3, alertsSent +0.1,
  invoicesProcessed +0.2, lessons +0.05) or down (errorsEncountered −0.2,
  postsRejectedByHITL −0.1). `customScore` bypasses the heuristic.
- **`computeQualityWithBreakdown(inputs)`** — bonus extension returning
  `{ score, contributions: [{signal, delta, reason}] }` for debug-grade
  observability surfaces (e.g. `/agents/[id]` quality trend tooltip:
  "Quality 0.75 = base 0.5 + postsPublished +0.2 + lessons +0.05").
- New public types: `QualityInputs`, `QualityBreakdown`, `QualityContribution`.
- `OutcomeRecord.quality` JSDoc updated to point at the SDK-side helper
  (previously a dangling reference to `@vauban-org/forge`).

### Migration (forge — 33 agents)

```bash
# in vauban-ecosystem/forge
sed -i 's|from "../shared/quality-scoring.js"|from "@vauban-org/agent-sdk"|g' \
  src/agents/**/*.ts
rm src/agents/shared/quality-scoring.ts
pnpm add @vauban-org/agent-sdk@^1.8.0
```

Pure helper, no behavioural change — score values are identical to the
forge implementation. Tests ported verbatim into SDK
(`tests/quality.test.ts`, 12 cases).

## 1.7.0 — reactLoop.onStep callback for per-iteration telemetry (2026-05-17)

### Added

- **`ReactLoopOptions.onStep`** — optional fire-and-forget callback
  invoked once per iteration **after** `step.thought + action +
observation/error` is finalized. Receives the completed `ReactStep`
  and a `ReactStepMeta = { iteration, durationMs, loopId? }`. Async
  variants are `await`ed so ordering is preserved between iterations.
  Errors (sync throw or async reject) are caught and logged via
  `opts.logger?.warn` — they NEVER propagate to the loop.
- **`ReactLoopOptions.loopId`** — optional correlation id propagated
  into `meta.loopId`, so callers can correlate multiple `reactLoop`
  invocations within one OODA cycle (e.g. forge sentinel running
  parallel sub-loops).
- **`ReactLoopOptions.logger`** — minimal `{ warn(msg, meta?) }`
  contract used only for swallowed `onStep` errors. Defaults to a
  no-op.
- New public types: `ReactStepMeta`, `ReactLoopLogger`.

### Migration (forge sentinel, ~377 LOC → ~50 LOC)

The forge sentinel's hand-rolled "wrap the LLM + executeTool to emit
telemetry on each ReAct iteration" plumbing collapses to one option:

```ts
await reactLoop({
  ...rest,
  loopId: cycleId,
  onStep: (step, meta) =>
    ctx.emitStep({
      type: "execution",
      phase: "react-iter",
      payload: { ...step, ...meta },
    }),
});
```

### Semantics

- Called once per iteration, AFTER `step.thought + action +
observation/error` is complete (both for tool-call iterations and
  the final-answer iteration).
- `meta.iteration === step.index`. `meta.durationMs = Date.now() -
iterationStart`. `meta.loopId = opts.loopId` (or `undefined`).
- NOT called on the aborted iteration when `AbortSignal` fires between
  iterations — the step is not finalized so no telemetry is emitted.

### Backward compatibility

100% — `onStep === undefined` keeps the 1.6.4 behavior bit-for-bit.
No existing export shapes change; `ReactLoopOptions` is widened only.

## 1.6.4 — Phase output surfacing applied to triggerCycle path (2026-05-17)

### Fixed

- The `output: out` passthrough added in 1.6.3 only reached one of two
  framework phase wrappers (`_runCycleWithSink`, the stream path). The
  `_runOodaPhase` wrapper used by `triggerCycle` (forge agents' code path
  via k8s-entrypoint) was missed by `replace_all`. Result : prod metadata
  still showed only `output_hash` in 1.6.3. 1.6.4 adds `output: out` to
  that site too. Both code paths now emit identical metadata.

## 1.6.3 — Phase output surfaced + telemetry.step emitted on completion (2026-05-17)

### Changed

- **`telemetry.step` now emitted at `completeStep`/`errorStep` instead of
  `insertStep`.** Each step produces exactly one event, with metadata
  merging the phase's INPUT (set at `insertStep`) and OUTPUT (set at
  `completeStep`). This closes the dashboard's "what did the agent
  produce?" gap that 1.6.2 had partially addressed.

  Concretely : step rows now carry both `input` AND `output` (PII-redacted
  - 4 KB-capped). Forge agents see decisions, LLM responses, tool outputs
    inline on `/runs/[id]` instead of just the input the phase consumed.

- **`errorStep` is now wrapped** to emit `telemetry.step` with status
  `"failed"` + `{ errorMessage, errorName }` merged into metadata. Pre-1.6.3
  failed steps were invisible in telemetry — only the DB row recorded the
  error. The dashboard now distinguishes failed vs completed phases.

- **Framework per-phase `completeStep` now passes `{ output_hash, output }`**
  (parallel to the 1.6.2 `{ input_hash, input }` change). Internal use ;
  no public API change.

### Backward compatibility

- `OODAContext.insertStep` / `completeStep` / `errorStep` signatures
  unchanged. Forge phases that already wrap their own IIFE around
  these continue to work.
- The `telemetry.step` event payload schema unchanged ; only the timing
  of emission moved. Sinks that aggregate by `stepIndex` see exactly
  one row per step now (previously one — same).
- Step `durationMs` is now actual wall-clock from `insertStep` to
  `completeStep` (was 0 or caller-supplied previously).

### Why 1.6.x patch series rather than 1.7

All three changes (1.6.1 emitStep, 1.6.2 input, 1.6.3 output) are
additive metadata richness — no breaking signature changes. Consumers
on `^1.6.0` pick them up automatically.

## 1.6.2 — Phase input surfaced in step metadata (2026-05-17)

### Changed

- Framework's per-phase `insertStep` now sends `{ input_hash, input }`
  instead of `{ input_hash }` only. PII redaction + 4 KB cap still applied
  by `buildTelemetryMetadata` before the wire, so prompts / tool args /
  observation inputs reach the dashboard `Phase payload` block. The
  `input_hash` field is preserved for replay determinism.

### Why

Pre-1.6.2 dashboards saw `{"input_hash": "len=109:..."}` and nothing else
— a debug hash with no readable content. Operator could not tell what an
agent actually observed / decided / executed. With `input` propagated,
the dashboard now renders the real phase input alongside the hash.

### Backward compatibility

Additive — `input_hash` field unchanged. Sinks that ignore unknown
metadata keys are unaffected. PII redaction means no secrets leak.

## 1.6.1 — `ctx.emitStep` fire-and-forget helper (2026-05-17)

### Added

- **`OODAContext.emitStep(input)`** — factorises the `insertStep → completeStep | errorStep`
  boilerplate that forge phases (publish_x, attest_run, hitl_pause,
  archive_brain, …) repeat in every `act` phase. Synchronous caller-side,
  swallows rejections via `logger.warn`, never throws, never blocks.

  ```ts
  // Before (forge/src/agents/19-outreach-writer/phases/act.ts:56-83)
  (async () => {
    const { stepId } = await ctx.insertStep({ type, phase, payload });
    if (status === "failed") await ctx.errorStep(stepId, new Error(error));
    else await ctx.completeStep(stepId, { ...payload, status });
  })().catch((err) => ctx.logger.warn?.({ err }, "[insertStep] failed"));

  // After
  ctx.emitStep({ type, phase, payload, status, error });
  ```

  Signature:

  ```ts
  emitStep(input: {
    type: OODAPhaseKind;
    phase: string;
    payload?: Record<string, unknown>;
    status?: "completed" | "failed" | "skipped"; // default "completed"
    error?: Error | string;                       // when status === "failed"
  }): void;
  ```

### Backward compatibility

`insertStep` / `completeStep` / `errorStep` remain exposed unchanged. `emitStep`
is additive sucre — zero breaking changes.

## 1.6.0 — Outcome propagation on telemetry.finish (2026-05-17)

### Added — decoupled outcome surface

- **`OutcomeRecord.quality?: number` (0..1)** — distinct from `confidence`.
  Measures the BUSINESS quality of the cycle output (publishedCount,
  threatsBlocked, invoicesProcessed, …) for consumers that want a single
  comparable score across heterogeneous agents. SDK does NOT compute it ;
  callers do. (See `@vauban-org/forge`'s shared `computeQuality()` helper
  for a reference heuristic.)
- **`TelemetryRunFinish.outcome?: { type, valueCents, quality?, confidence?, metadata? }`** —
  when `OODAAgentConfig.outcomeMapping(feedback)` returns a record, the SDK
  now propagates it on the `finish` telemetry event. Pure data — the SDK
  itself never persists. Sinks decide what to do : the CC sink writes
  `agent_run.outcome_quality`, OTLP collectors surface as span attributes,
  custom HTTP webhooks see the JSON as-is.

### Why decoupling matters

Pre-1.6 the SDK's `runCycle` called `outcomeMapping(feedback)` but only
logged the result. Agents could `quality: computeQuality(fb)` to their
hearts' content — the value never left the loop scope. 1.6 closes the
loop without coupling the SDK to any specific persistence backend.

### Migration

Zero breaking changes. Agents that already return a richer OutcomeRecord
(forge agents post-`feat(forge): wire computeQuality across all agents`)
will immediately see their `quality` surface in dashboards consuming the
new event field. Agents returning the legacy 1.5 shape work unchanged.

### Refs

- ADR-ECO-039 (decoupling principle)
- Forge session 2026-05-17 brief : `computeQuality()` wiring is now
  end-to-end active.

---

## 1.5.0 — Telemetry step `metadata` field (2026-05-16)

### Added — metadata field on TelemetryRunStep

- **`TelemetryRunStep.metadata?: Record<string, unknown>`** — already declared
  on the port type in 1.3.0 but never populated. The 1.4.0 `insertStep`
  wrapper now propagates the _full_ `input.payload` of every phase
  (observe / orient / decide / act / feedback) on the wire event so dashboards
  can render the real content of each cognitive step — not just token counts.
- **PII redaction by default** : string values keyed by `secret`, `token`,
  `password`, `apiKey`, `api_key`, `api-key` (case-insensitive) are replaced
  by `"[REDACTED]"`. Bypass with `TELEMETRY_INCLUDE_PAYLOADS=true` for
  sovereign self-hosters who audit their own runs.
- **4 KB size cap** : payloads larger than 4 096 bytes after JSON
  serialization are replaced by `{ truncated: true, originalBytes }` so
  dashboards can flag the omission rather than silently render half a payload.
- **Backward compat** : when `input.payload` is absent / empty, the
  `metadata` field is omitted entirely — the wire shape is unchanged for
  1.4.x agents.

### Migration

Zero code changes for agents already passing rich payloads to `insertStep`.
Forge / preste / Command Center agents will see real LLM prompts, tool
outputs, decision bodies on `/runs/<id>` from this release onward.

To opt out (e.g. compliance regimes that forbid prompt egress), agents can
override the SDK by emitting telemetry.step events without `metadata`, or by
sanitising payloads at the call site before invoking `insertStep`.

### Refs

- ADR-ECO-039
- Sprint `command-center:sprint-B:telemetry-metadata`
- Migration `046_telemetry_step_metadata.sql` (CC backend)

---

## 1.4.0 — Telemetry step events + cumulative totals (2026-05-16)

### Added (additive — no breaking changes)

- **OODA `insertStep` wrapper auto-emits `telemetry.step`** with the payload's
  `inputTokens` / `outputTokens` / `toolCalls` / `costUsd` / `durationMs`
  fields. `stepIndex` is auto-incremented per cycle, `kind` is taken from
  `input.phase` (fallback `input.type`). Previously only `start` and `finish`
  events were emitted, leaving the run-level dashboard with zero per-step
  granularity.
- **Cumulative totals on finish**: a per-cycle accumulator (`telemetryTotals`)
  sums each step's tokens/cost/tool-calls and passes them as
  `totalInputTokens` / `totalOutputTokens` / `totalCostUsd` / `totalToolCalls`
  on the `finish` event. Consumers (CC dashboard, OTLP collector) get the
  full picture without recomputing from raw step rows.

### Migration

Zero work required for agents that already pass `{inputTokens, outputTokens,
costUsd, toolCalls}` in `insertStep` payloads (per the 1.0 contract). The new
events surface automatically on the next deploy that bumps to 1.4.0.

Agents that don't yet pass those fields will see tokens=0/cost=0 in the
dashboard — same as 1.3.0. Wire the LLM provider hook to populate them.

### Refs

- ADR-ECO-039
- Sprint `command-center:sprint-693:wire-ooda` (extension)

---

## 1.3.0 — TelemetryPort multi-sink observability (2026-05-16)

### Added (all additive — no breaking changes)

- **`telemetry` module** (`packages/agent-sdk/src/telemetry/`) — per ADR-ECO-039:
  - `TelemetrySink` interface (port pattern). Implementations are pluggable at config time.
  - `createTelemetryBus({sinks, logger?, nonBlocking?, maxQueueDepth?})` — fanout to N sinks with failure isolation, backpressure (drop-oldest), and Prometheus-friendly counters.
  - `NOOP_TELEMETRY_SINK` — default when no sinks configured.
  - `TelemetrySinkError` for boundary cases.
- **Three zero-dep sinks** :
  - `stdoutTelemetrySink({stream?, json?})` — JSON-line emission to stderr (dev visibility, `jq`-friendly).
  - `localSqliteTelemetrySink({path?, readonly?})` — sovereign local mirror, default `~/.vauban/runs.db`. `better-sqlite3` as **peerDependencyOptional**; sink degrades to no-op if absent.
  - `otlpTelemetrySink({url, headers?, serviceName?, fetchImpl?, timeoutMs?})` — OTLP/HTTP (JSON-encoded) exporter with OTel GenAI semantic conventions. Compatible with Langfuse self-host, Tempo, Jaeger, Honeycomb.
- **`OODAAgentConfig.telemetry`** — optional `TelemetrySink` (single or bus) injected at agent creation. Auto-emits `start` + `step` + `finish` events per OODA cycle. **Failures are isolated — never block the agent.**
- **`TelemetryRunStatus`** = `"success" | "failed" | "skipped" | "timeout" | "incoherent"` — adds explicit `"skipped"` for session_guard / risk_guard / heap_exceeded short-circuits (previously lumped under success).

### Deprecated (still exported, removal targeted for 2.0)

- `createAgentRunTracker(db)` and `AgentRunTracker` interface — the implicit DB-coupling pattern. Migrate to `telemetry.sinks: [...]` configuration. The legacy tracker remains a valid sink-equivalent for backward compatibility ; consumers should phase out direct INSERT-by-SDK over the next two minors.

### Migration

Zero breaking changes. Existing 1.2.x consumers continue to work as-is. To opt in to multi-sink telemetry, add to `createOODAAgent({...})` :

```ts
import {
  stdoutTelemetrySink,
  localSqliteTelemetrySink,
  createTelemetryBus,
} from "@vauban-org/agent-sdk";

createOODAAgent({
  ...,
  telemetry: createTelemetryBus({
    sinks: [stdoutTelemetrySink(), localSqliteTelemetrySink()],
  }),
});
```

For the Vauban Command Center SaaS sink, install the separate `@vauban-org/cc-telemetry` package (ships in v1.4).

### Refs

- ADR-ECO-039 (accepted 2026-05-16)
- Sprint command-center:sprint-693 (port-interface, telemetry-bus, sink-stdout, sink-sqlite, sink-otlp, wire-ooda, release-1-3)
- Plan : `command-center/docs/plans/2026-05-16-agent-sdk-telemetry-port.md`
- Brain : cea38397 (ADR root), 0e153bda (pattern), 95511458 (SQLite sovereignty), 7e18f454 (free tier policy)

---

## 1.2.0 — Retry primitives + container execution protocol + SkillContext audit trail (2026-05-15)

### Added (all additive — no breaking changes)

- **`retry` module** (`packages/agent-sdk/src/retry/`):
  - `retry(fn, opts)` async helper with exponential backoff and ±25% jitter (anti-thundering-herd).
  - `RetryContext` class for manual control flow when the retry shape doesn't fit a single `fn()`.
  - `RetryExhaustedError`, `calculateDelay`, `shouldRetry` exposed for callers that want lower-level control.
  - Four named presets: `RETRY_TRANSIENT` (3 attempts, 1s/10s, honors `retryable` flag), `RETRY_AGGRESSIVE` (5 attempts, 500ms/30s), `RETRY_PATIENT` (10 attempts, 2s/120s), `NO_RETRY` (1 attempt).
  - Injectable `sleepFn` for deterministic tests.
- **`container` module** (`packages/agent-sdk/src/container/`):
  - Reserved `PROTOCOL_ENV` keys (`VAUBAN_EXECUTION_ID`, `VAUBAN_AUTOMATION_NAME`, `VAUBAN_INPUT`, `VAUBAN_TIMEOUT`, `VAUBAN_MODE`).
  - `ProtocolResult` discriminated union (`completed` | `failed`), `ExecutionResult` outcome type, `ProtocolParseError`.
  - `buildProtocolEnv` (caller `extraEnv` cannot override reserved keys) and `parseProtocolOutput` (last non-empty stdout line as JSON).
  - `ContainerRuntime` with two modes: `executeBinary` (local subprocess via injectable `SpawnFn`) and `executeContainer` (delegates to a host-provided `SandboxExecutor` port — structurally compatible with Command Center's hardened `DockerExecutor`).
  - 1 MB output cap with truncation marker; protocol "failed" payloads honored even on non-zero exit.
- **`SkillContext` extensions** (`packages/agent-sdk/src/orchestration/ooda/skills.ts`):
  - Five new OPTIONAL fields: `executionId`, `secrets` (audit-trail-bearing accessor), `progress` callback (`[0,1]` clamp), `elapsedSeconds`, `remainingSeconds`.
  - `SecretsAccessor` port — every `get`/`has` lookup is recorded in `accessedSecrets`, regardless of outcome. Foundation for proof-grade attestation per ADR-ECO-027.
  - `InMemorySecretsAccessor` and `NOOP_SECRETS` default; `SecretNotFoundError` thrown when secret is missing without a `defaultValue`.
  - `createSkillContext()` factory with live (per-read) `elapsedSeconds` / `remainingSeconds`.
  - Existing 14+ skills compile and run unchanged — legacy contexts with the original 4 fields still satisfy the interface.
- **`send_email` skill** now prefers `ctx.secrets` over `process.env` when an accessor is configured, contributing `RESEND_API_KEY`/`SMTP_URL`/`EMAIL_FROM` to the run's audit trail. Falls back to env when no accessor is provided.

### Background

Migration of three modules from a Python reference implementation per ADR-ECO-036, ported in three sprints (680 retry, 684 container, 685 SkillContext). Removes ad-hoc exponential backoff scattered across `src/lib/brain-token-client.ts` and `src/proof/starknet-anchor-client.ts` in favor of a single, jittered, preset-configured helper. Unlocks polyglot binary execution (Rust, Python wrappers) under the same uniform protocol Command Center already uses for Docker sandboxing.

### Tests

90 new Vitest cases (24 retry + 27 container + 17 SkillContext + 22 SKILL.md loader baseline), all green. Full agent-sdk and CC `tsc` clean.

---

## 1.0.0 — Stable public API (2026-05-08)

### Breaking changes

- **`OODAAgentConfig.deps` is now required.** Was optional (`deps?`) in 0.17.x for legacy compatibility. Remove `SDK_STRICT_DEPS` env workaround — boot validation now always enforces `deps.llm`. Migrate: pass `deps` to every `createOODAAgent` / `AgentFactory.create` call.
- **`SdkToolEntry` type removed.** Use `AgentTool` from `"@vauban-org/agent-sdk"` directly.
- **`EventBusPort.subscribe(stream, group, handler): Promise<() => void>` overload removed.** Use `subscribeDomain()` for DomainEvent subscriptions. No consumers were found in internal codebase.

### Added

- **`"@vauban-org/agent-sdk/economy"` export path.** `ProviderTier`, `EconomyRouter`, `EconomyMode`, `RouteDecision`, `OutcomeTracker`, `ModelTier`, `TierPolicy`, `FleetCircuitBreaker` — all now importable via the canonical subpath.

### Migration guide (0.17.x → 1.0.0)

```ts
// BEFORE
import type { SdkToolEntry } from "@vauban-org/agent-sdk";
// AFTER — use AgentTool
import type { AgentTool } from "@vauban-org/agent-sdk";

// BEFORE — deps was optional
const agent = createOODAAgent({ id: "...", phases: { ... } });
// AFTER — deps is required
const agent = createOODAAgent({ id: "...", deps: { llm, eventBus, logger }, phases: { ... } });

// BEFORE — ProviderTier was local copy in Forge
import type { ProviderTier } from "../economy/forge-tiers.js";
// AFTER — from SDK
import type { ProviderTier } from "@vauban-org/agent-sdk/economy";
```

---

## 0.17.0 — Forge promotions (Vague 1.B) — backward-compatible (2026-05-07)

### Added (all additive — no breaking changes)

- `AgentFactory` + boot patterns promoted from Forge (`boot/init-sdk`, `boot/load-agent-context`, `boot/load-recent-memory`)
- `SkillRegistryBuilder` + `buildDomainSkills` pattern promoted
- Tier templates: `SimpleAgent`, `ComplexAgent`, `ReasoningAgent` (via `templates/simple-agent`, `templates/complex-agent`, `templates/reasoning-agent`)
- `buildOrientPrompt` + `parseStructuredOutput` helpers (`llm/build-orient-prompt`, `llm/parse-structured-output`)
- `EconomyRouter` promoted (`economy/economy-router`)
- HITL infrastructure 529L promoted (email approval channel, Slack/Telegram approval, state store)
- Platform clients sub-package `@vauban-org/agent-sdk-platforms` (X, Farcaster, Rempart)
- Full public API export in `index.ts` covering all Vague 1.A + 1.B modules

### Note

SDK 1.0 with `--tag latest` will ship in Vague 3.3 post-Forge full migration. Use `@beta` for now.

---

## 0.16.0 — Strict port interfaces + OODA validation (2026-05-07)

### Added

- Strict port interfaces: `LLMProviderPort`, `MessagingChannelPort`, `AgentRegistryPort`, `HITLPort`, `EventBusPort`
- OODA loop strict dependency validation — throws on missing required deps (legacy mode deprecated)
- MkDocs P0 documentation added (`mkdocs.yml` + `docs/` structure)

---

## 0.14.2 — OODA OTel + Dashboard Registry (2026-05-01)

### Added

- OODA loop OTel instrumentation: `agentSpan()` per cycle + per-phase spans (`ooda.phase.*`)
  with run_id, step_id, duration_ms attributes on both `runCycle()` and `_runCycleWithSink()`
- Skip paths (session guard, risk guard, heap) now emit spans with skip_reason
- `agentVersion` optional field on `OODAAgentConfig`

### Fixed

- Dashboard: `/registry` added to sidebar menu (replaces `/agents` + `/pipelines`)
- `GET /api/agents/registry` now includes `external` agents from DB (Forge agents detected)
- `POST /api/registry/agents` stores external agents in `agents` table

---

## 0.13.0 — sprint-564 (2026-04-30)

### Added — x402 Adapter

- New package `@vauban-org/agent-sdk-x402`: HTTP 402 Payment Required adapter
- `parseX402Header()`, `buildX402Header()`, `build402Response()`, `verifyX402Payment()`

### Added — Learning Loop Shadow Mode (C2)

- `shouldLearn()` composite trigger: toolCallCount≥4, roi>0, durationMs>5000, !wasReplay
- `extractSkillFromTrace()` via LLM-as-optimizer, opt-in feature flag gate only
- `GOLDEN_FIXTURES` snapshot for drift detection

### Added — Immune Detection MAAG (C3)

- `cosineSimilarity()` vector comparison
- `StressLedger` — ISOLATED from BrainPort (P4 security boundary)
- `validateGoldenFixtures()` against `GOLDEN_ATTACK_EMBEDDINGS`

### Added — Memory Tiers Semantic + Procedural (C4)

- Tier 3 Semantic: `SemanticMemoryPort` — `query()`/`archive()` shared inter-agents
- Tier 4 Procedural: `ProceduralMemoryPort` — `resolveSkills()`/`registerSkill()`/`shareSkill()`
- `InMemorySemanticMemory`, `InMemoryProceduralMemory`
- Completes A6 (working + episodic): full 4-tier Brain memory model

### Changed

- `package.json` version: 0.12.0 → 0.13.0 (MINOR — additive only)

---

## 0.12.0 — sprint-563 (2026-04-30)

### Added — Guardrails (B1)

- `runPreGuards()`, `runPostGuards()` — pre-phase BLOCKING, post-phase REJECT
- `PII_GUARD` — RFC 5321 email + Luhn CC detection
- `createMaxInputLengthGuard()`, `guardrailViolationToEvent()`

### Added — Multi-Agent Handoff (B2)

- `handoff()` agent-to-agent with `handoffChain` anti-cycle (`HandoffCycleError`)
- `asAgentTool()` — AgentDescriptor → MCP tool
- `handoffToEvent()` for trace integration

### Added — Trajectory Export (B3)

- `exportTrajectory()` RLHF/DPO formats (jsonl, openai-dpo)
- Auto-label by outcome `value_cents`

### Added — Phase-Level Model Routing (B4)

- `resolveForPhase()`, `getFallbackChain()` with provider dedup
- `PhaseModelConfig` + `ModelSpec` with fallback cascade

### Added — MCP Subpath (B5)

- `skillRegistryToMCPServer()` → subpath `@vauban-org/agent-sdk/mcp`

### Added — Behavioral Eval (B6)

- `runEval()`, `runEvalSuite()` with LLM scorer

### Added — AgentMeter + OutcomeGate (B7)

- `AgentMeter` append-only ledger: `recordRun()`, `getBalance()`, `verifyChain()`
- `validateOutcome()` with min/max/cumulative gates

### Added — Agent Cards (B8)

- `toAgentCard()`, `validateAgentCard()` — A2A v1.2 (Linux Foundation)
- CH8 signing via `signingKey.sign()`

### Added — HTTP VCR (B9)

- `HttpVCR` record/replay, `UndeterministicSideEffectError` on strict miss

### Changed

- `package.json` version: 0.11.0 → 0.12.0 (MINOR — 9 additive features)
- `VerifyChainResult` renamed to `MeterVerifyResult` (dedup with proof/chain.ts)

---

## 0.11.0 — sprint-562 (2026-04-30)

### Added — Structured Output (A5)

- `withStructuredOutput<T>({schema, fn, maxRetries})` — Zod retry in messages[] thread
- `StructuredOutputError`

### Added — Brain Ports Working + Episodic (A6)

- Tier 1: `WorkingMemoryPort` — get/set/delete with scope='run' + ttlMs
- Tier 2: `EpisodicMemoryPort` — since/record per agentId
- `InMemoryWorkingMemory`, `InMemoryEpisodicMemory`

### Added — CLI Doctor + Export (A7)

- `vauban-agent doctor` — 5 audit checks (policy, key colocation, non-deterministic globals)
- `vauban-agent export --format=audit-pdf` — 4-page PDF via pdfkit

### Added — ESLint Plugin Determinism (A8)

- `@vauban-org/eslint-plugin-determinism`
- Rule `no-non-deterministic-globals` with auto-import suggestions

### Changed

- `package.json` version: 0.10.1 → 0.11.0 (MINOR — additive only)

---

## 0.10.1 (2026-04-30)

### Added

- `initVaubanSDK()` — lightweight OTel init registering resource attributes
- `getSDKConfig()`, `createOtelClient()`

### Fixed

- 0.10.0 was published without `initVaubanSDK` in the tarball

---

## 0.10.0 — sprint-561 (2026-04-29)

### Added

- OODA streaming: `streamCycle()` AsyncIterable<CycleEvent>, 10 discriminated union variants
- TRACE_V1 schema: `Trace`, `TraceStep`, `SignedReceipt` at `TRACE_SCHEMA_VERSION = '0.1.0-draft'`
- `canonicalize()` RFC 8785 with Buffer/Date/BigInt/NaN handling
- `PayloadPolicy` 4-axis (include/redact/hmac/hash-only), `defaultPolicy()` fail-closed
- `STRICT_PII_DETECTOR` opt-in (RFC 5321 email + Luhn IBAN)
- `KeyProvider` port: `EnvKeyProvider` + `ExternalKMSKeyProvider`
- Deterministic replay: `ClockPort`/`RandomPort` dual API, `LLMResponseCache`, `replayFrom()`
- ProofChain: `buildChain()`/`verifyChain()` 7 checks, `sha256()`/`hmacSha256()` 0-dep
- `TimestampPort` interface, `ReceiptQueue` HMAC-signed with exponential backoff
- CLI: `vauban-agent verify`, `vauban-agent replay`
- Resilience: `circuitBreaker()`, `idempotent()`, `bulkhead()`, `BoundedTtlCache`
- Subpaths: `./testing`, `./proof`, `./outcomes`, `./testing/chaos`

### Changed

- `package.json` version: 0.9.0 → 0.10.0 (MINOR — 8 features, no breaking changes)

---

## 0.9.0 — sprint-553 (2026-04-29)

### Added

- **Pattern A: SessionCircuitBreaker** (`@vauban-org/agent-sdk/patterns/circuit-breaker`)
  Session-level OODA circuit breaker. Tracks tokens, consecutive errors,
  actions, elapsed time, cost. State machine: closed/open/half-open.
  Integrates as RiskGuard. Distinct from `resilience/circuitBreaker`.
  Types: `SessionCircuitBreaker`, `CircuitBreakerConfig`, `CircuitSnapshot`.

- **Pattern B: QualityGate** (`@vauban-org/agent-sdk/patterns/quality-gate`)
  Multi-dimensional weighted quality scoring. Routing: auto/async_review/
  hitl_block. NaN/Infinity guard on evaluator scores. Brain category: operations.
  Types: `QualityGate`, `QualityGateConfig`, `QualityScore`, `QualityEvaluator`.

- **Pattern C: EscalationPyramid** (`@vauban-org/agent-sdk/patterns/escalation`)
  Declarative action autonomy levels with confidence-based escalation.
  Unknown actionTypes → L3 (fail-safe). dry-run → always L1.
  Runtime override/clearOverride without redeployment.
  Types: `EscalationPyramid`, `EscalationLevel`, `ActionDeclaration`, `EscalationDecision`.

- `src/patterns/_shared/brain-logger.ts` — shared fire-and-forget Brain helper.
- 3 subpath exports in `package.json`.
- `docs/patterns.md` — reference doc (≤200 lines).
- Integration test `tests/patterns-integration.test.ts`.

### Changed

- `package.json` version: 0.8.4 → 0.9.0 (MINOR — additive only, no breaking changes).

---

## 0.8.4 — sprint-477 (chaos testing module)

### Added

- `injectBrainFailure<P extends BrainPort>(port, { failureRate, type?, random? }): P`
  — BrainPort-typed chaos wrapper; injects rate-limit, timeout, network, or random
  errors at a configurable probability. Thin typed facade over `injectFailure`.
- `wholeCircuit<P>(port): P` — trips every call (BrainUnavailable); designed for
  HALF-OPEN probe testing in combination with `circuitBreaker` + controllable clock.
- `exhaustResources<P>(port, { maxCalls, err? }): P` — allows first N calls to
  succeed, then throws on every subsequent call; simulates quota exhaustion.
- `networkJitter` extended with `p99Ms`/`p50Ms` options: models a log-normal latency
  distribution; backward-compatible with existing `minMs`/`maxMs` callers.
- Subpath export `./testing/chaos` in `package.json`.
- `src/index.ts` section 21: type-only re-exports (no Proxy overhead in production bundles).
- Integration tests `tests/integration/narrator-chaos.test.ts` (4 scenarios) and
  `tests/integration/circuit-validation.test.ts` (11 scenarios) covering sprint-468
  primitives under chaos-injected failure modes.

### Changed

- `FailureType` extended: `"timeout"` and `"network"` variants added; `"random"` now
  uniformly samples the 4 concrete types.

Bump: 0.8.3 → 0.8.4 (MINOR — new public API surface, no breaking changes).

---

## 0.8.3 — sprint-468:idempotency-keys,bulkhead

### Added

- `orchestration/idempotency.ts`: `computeIdempotencyKey`, `withIdempotency`, `addIdempotencyHeader`
  — orchestration-layer deduplication and HTTP key propagation primitives.
- `orchestration/bulkhead.ts`: `createBulkhead<T>` factory — bounded worker pool with FIFO queue,
  fast-reject on full, and live `metrics()` snapshot (active / queued / rejected / completed).
- `orchestration/index.ts`: top-level barrel re-exporting OODA loop + new idempotency + bulkhead.
- All exports added to main `src/index.ts` (no breaking changes — additive only).

## 0.8.2 — sprint-524:quick-9

### Added

- `agents` client: `createAgentsClient({baseUrl, getToken})` with `.execute()`, `.listRegistry()`
- `pipelines` client: `createPipelinesClient({baseUrl, getToken})` with `.run()`, `.list()`, `.status()`
- Messaging adapters: `triggerFromTelegram`, `triggerFromSlack` — thin client-side wrappers

### Note

The cc:execute scope BREAKING change documented in plan v10 is already in effect
via sprint-524:quick-1 warnOnly grace path (CC_ENFORCE_EXECUTE_SCOPE feature flag).
This task adds CLIENT-SIDE helpers; no BREAKING SDK API change — additive only.

## 0.8.1 — patch (logger noop default)

### Fixed

- `createOODAAgent({ ... })` without `logger` field crashed at first cycle with
  `TypeError: Cannot read properties of undefined (reading 'error')`. Logger now
  defaults to a noop implementation (`NOOP_LOGGER`) when not injected by the host.
- Discovered via post-publish smoke test against npmjs.org @vauban/agent-sdk@0.8.0.

### Migration

None — pure fix, no API change. Existing hosts that already inject `logger`
unaffected.

## 0.8.0 — sprint-530:quick-4

### Added

- `SkillLedgerEntry` — type mirroring `skill_ledger` DB schema (migration 028):
  `id`, `skill_name`, `skill_sha256`, `source_run_ids`, `agent_id`, `outcome_type`,
  `brain_entry_id`, `metrics`, `lifecycle_state`, `created_at`.
- `SkillLifecycleState` — `"active" | "archived" | "deprecated"`.
- `ResolveSkillsOptions` — `agentId`, `outcomeType`, optional `limit`.
- `resolveSkillsForAgent(skills, opts)` — LIFO scope-typed resolver:
  - Filters by `agent_id === agentId` OR `agent_id === '*'` (cross-agent wildcard)
  - Filters by `outcome_type` exact match
  - Filters by `lifecycle_state === 'active'`
  - Sorts descending by `created_at` (most recent wins)
  - Pure function, no side effects.
- All symbols exported from `skills/index.ts` (re-exported via main entry section 17/19).

Bump: 0.7.1 → 0.8.0 (MINOR — new public API surface, no breaking changes).

---

## 0.7.1 — sprint-526 Bloc 5b

### Added

- agents/trading: `Trade`, `RiskGuardState`, `OrientationMemory`, `TradingNQConfig` types
- `computeKellyFraction(historicalCount, expectedReturn, variance, config)` — Kelly with bootstrap fallback (V5 piège 2)

## 0.7.0 — sprint-525 Bloc 5a

### Added

- OODA orchestration primitive: `createOODAAgent({phases, executionMode, ...})`
- Types: `OODAAgent`, `OODAAgentConfig`, `OODAContext`, `PhaseDef`,
  `SessionGuard`, `RiskGuard`, `OutcomeRecord`, `ResourceLimits`,
  `ExecutionMode`, `CycleStatus`, `OODAPhaseKind`
- 10 anti-patterns enforced by-design (constructor validation +
  sequential while+sleep loop + readOnly observe/orient enforcement +
  required executionMode + no-TTL risk guards + session guards +
  HITL gate hook + skip-on-tripped + configurable resource limits +
  heap watermark monitoring)
- Skill registry interface (`Skill`, `SkillContext`, `SkillRegistry`,
  `EMPTY_SKILL_REGISTRY`) — concrete implementations land in 0.7.x
  (sprint-525:quick-5)
- `DEFAULT_RESOURCE_LIMITS` constant (60s phase / 200 steps / 256MB heap)

Bump: 0.5.3 → 0.7.0 (MINOR — new public API surface, no breaking change
to existing exports).

### Added — sprint-525:quick-6 (multimodal + MCP forward-compat)

- `MultiModalObservation` type: `text?`, `imageBase64?`, `audioBase64?`,
  `documentUrl?` — typed container for OBSERVE outputs with non-text content.
- `isMultiModal(obs)` — type guard; `true` when at least one media field present.
  ORIENT phase uses this to route to vision-capable model (Claude Opus 4).
- `multiModalToAnthropicContent(obs)` — converts to Anthropic Messages API blocks:
  `text` → TextBlock · `imageBase64` → ImageBlock (base64) · `audioBase64` →
  TextBlock data-URI (pending native audio) · `documentUrl` → DocumentBlock URL.
- `AnthropicContentBlock`, `AnthropicTextBlock`, `AnthropicImageBlock`,
  `AnthropicDocumentBlock`, `ImageMediaType`, `AudioMediaType` — supporting types.
- All multimodal symbols exported from main entry via `orchestration/ooda/index.ts`.

## 0.5.3 — sprint-523 Bloc 3

### Added

- runs module: `subscribeToRun()` with SSE + Last-Event-ID auto-reconnect (Node + browser via fetch ReadableStream)
- `createRunsClient()` with `getHealth`, `getAnomalies`, `getCircuitBreakers` REST clients
- otel module: `createOtelClient()` + `ingestSpans` helper for LangGraph/AutoGen integration
- Types: `RunStreamEvent`, `RunStreamEventName`, `AgentHealth`, `Anomaly`, `CircuitBreakerSnapshot`, `OtlpRequest`, `OtlpSpan`, `OtlpAttribute`, `OtlpAttributeValue`

Bump: 0.5.2 → 0.5.3 (PATCH, additions only).

## 0.5.2 — sprint-521 Bloc 1

### Added

- proof module: `RunStep`, `RunProofCertificate`, `CertState`, `LogSeverity` types
- `computeLeafHash` + `computeMerkleRoot` (Poseidon, via starknet.js)
- `verifyProofCertificate(cert)` — pure function, recomputes Merkle root and compares
- `loadProofCertificate({ runId, baseUrl, getToken })` — REST client
- `toOtelSpan(step)` — OpenInference-compatible OTel span mapping

Note: per plan v10 SemVer table, proof was meant to ship as 0.5.0 (Bloc 1) before
outcomes (0.5.1, Bloc 2). Topological execution shipped outcomes first (sprint-522:quick-6,
commit ac10a96); proof additions land as 0.5.2.

## 0.5.1 — sprint-522

### Added

- outcomes module: types (`Outcome`, `OutcomeSummary`, `RoiPerAgent`, `CfoView`)
  with `pending_attribution_count` and `pending_value_estimate_cents`.
- `computeRoi(input)` — pure client-side ROI computation. Handles divide-by-zero,
  external cost map, and pending outcome separation.
- `createOutcomesClient(opts)` — `list`/`summary`/`cfo`/`roi` REST client with
  `OutcomesApiError` for 4xx responses.
- `OutcomesListFilter`, `OutcomesListResponse`, `OutcomesClientOptions` — supporting
  types for the client.

SDK contract for `/api/outcomes/*` routes (to be implemented in sprint-522:quick-4).
Bump: 0.5.0 → 0.5.1 (PATCH, additions only).

## 0.5.0

### Minor Changes

- fbd8220: Export previously internal symbols needed by consumers:
  - `compactToolLog`, `emergencyContextSummary`, `LogMessage` from budget layer
  - `agentSpan`, `llmSpan`, `toolSpan`, `recordLlmUsage`, `recordToolResult` from OTel tracking
  - `DEFAULT_INSTRUCTION_PATTERNS`, `SanitizedItem` from safety layer
  - `AgentRunStartInput`, `AgentRunStepDelta`, `AgentRunFinish` from run tracker

  These were reachable via subpath imports but missing from the main entry point.

All notable changes to this package will be documented here.
Format: [Keep a Changelog](https://keepachangelog.com/), SemVer.

## [0.4.2] — 2026-04-24

CI-only: `google/osv-scanner-action` doesn't resolve from a marketplace
action reference; switched to direct CLI install from the GitHub release.

## [0.4.1] — 2026-04-24

CI-only: `google/osv-scanner-action@v2` doesn't exist; pinned to `@v1`.
No code change.

## [0.4.0] — 2026-04-24

Sprint-467 — institutional supply-chain hardening. No API change; minor
bump reflects the new release-artefact contract.

### Added per published tarball

- `.sbom.cdx.json` — CycloneDX SBOM (full dependency inventory).
- `.provenance.intoto.json` — SLSA v1 build provenance predicate
  (buildDefinition, resolvedDependencies, runDetails).
- `.provenance.sigstore` — cosign attestation of the predicate, verifiable
  via `cosign verify-blob-attestation`.

### Added in CI

- `pnpm audit --audit-level=high` gate — blocks publish on HIGH/CRITICAL
  advisories in transitive deps.
- OSV scanner (google/osv-scanner-action) — surfaces known CVEs against
  the pnpm-lock; non-blocking initially, blocking in a follow-up sprint.

### Consumers

See `VERIFICATION.md` for the full verify flow (cosign verify-blob +
verify-blob-attestation + cyclonedx validate).

## [0.3.2] — 2026-04-24

Sprint-466 — sovereign supply-chain attestations.

### Changed

- CI no longer depends on GitHub's Attestation API (closed to user-owned
  private repos). Publish workflow now:
  1. Installs cosign on the runner.
  2. Signs the packed tarball with `cosign sign-blob` via keyless OIDC
     (Fulcio cert, Rekor transparency log).
  3. Uploads both the tarball and its `.sigstore` bundle as assets on
     the `sdk-v*` GitHub release via softprops/action-gh-release.

### Added

- `packages/agent-sdk/VERIFICATION.md` — step-by-step guide for
  consumers to verify signatures with `cosign verify-blob`.

### No API change

Code identical to 0.3.1. Version bumped to trigger the new attested
publish flow.

## [0.3.1] — 2026-04-24

No code changes — CI-only. Attestation step softened to non-blocking
(`continue-on-error: true`) because GitHub Attestation API requires
public or org-owned repos. Publish itself proceeds and the Sigstore
signature is still emitted to the Rekor transparency log.

## [0.3.0] — 2026-04-24

Initiative: Agent Platform SOTA Institutional. Six concurrent sprints
ship institutional-grade tooling on top of the v0.2.x ports.

### Added

- `deprecated()` helper + `DeprecationOptions` type. One-time-per-
  call-site warning emission; N-2 minor removal policy documented in
  CONTRACT.md. (Sprint-457)
- `PortError` base + typed subclasses: `BrainUnavailable`,
  `BrainRateLimit` (with `retryAfterMs`), `BrainValidationError`,
  `BrainAuthError`, `DbConnectionLost`, `DbQueryError`,
  `OutcomeAttributionFailed`. Helpers `isPortError()` +
  `isRetryablePortError()`. (Sprint-459)
- `tracedPort(impl, options)` — Proxy wrapper emitting OTel spans per
  method call. GenAI semantic conventions. No-op when no tracer
  installed. (Sprint-460)
- New subpath export `@vauban-org/agent-sdk/testing` with conformance
  test suites for `BrainPort`, `OutcomePort`, `LoggerPort`, `DbPort`.
  Runner-agnostic (inject describe/it/expect). (Sprint-455)

### Changed

- Published with SLSA build provenance via GitHub OIDC → Sigstore.
  Verify tarballs with `gh attestation verify`. (Sprint-454)
- Release workflow now gated by `@changesets/cli`. Pending changesets
  open a version-packages PR; merging it publishes to GHCR with
  attestations. (Sprint-458)
- API reference auto-generated by TypeDoc, deployed to GitHub Pages
  on every main push. (Sprint-461)

### No API break

All 0.2.x exports are preserved. 0.3.0 is a minor bump because it adds
new exports, a new subpath, and a dev-dep on
`@opentelemetry/sdk-trace-base` (not shipped to consumers).

## [0.2.2] — 2026-04-24

No code changes — re-publish to trigger the agent matrix with a clean
self-hosted runner state (previous 0.2.1 run hit stale cached symlinks).

## [0.2.1] — 2026-04-24

Build-time resilience. No API changes.

### Changed

- Consumer packages using `composite: true` should depend on agent-sdk
  via TypeScript project references and build with `tsc -b`. Documented
  in CONTRACT.md build-consumers section. This resolves a matrix-build
  failure on self-hosted runners where pure `tsc` without `-b` produced
  `TS2307` errors resolving symlinked `@vauban-org/*` packages.

## [0.2.0] — 2026-04-24

Sprint-449 — SDK pure distribution. Ports added so agent plugins can be
published on GHCR without depending on the Command Center host source.

### Added

- `LoggerPort` — Pino-compatible subset for structured logging, plus
  `noopLogger` convenience for tests.
- `BrainPort` — `archiveKnowledge()` + optional `queryKnowledge()` for
  knowledge archival and retrieval. Agents depend on this interface only.
- `OutcomePort` — fire-and-forget `recordOutcomeAsync()` hook for agent
  outcome attribution (monetary value, backfill queue, etc.).
- `DbPort` — alias for the existing `DbClient` minimal Pg interface,
  kept for naming consistency across ports.
- Public type exports: `BrainEntry`, `BrainEntryInput`, `BrainQueryFilters`,
  `AgentRunRef`.

### Purpose

Three of the four reference agents (`forecaster`, `market-radar`,
`narrator`) previously imported internals from the `command-center`
package at runtime (e.g. `command-center/dist/brain/client.js`). Those
imports blocked external publication because `workspace:*` specifiers
do not resolve outside the monorepo. Ports replace these direct imports
with interfaces; the host (Command Center) wires concrete implementations
at boot time via each agent's `setXxxDeps()` setter.

### No breaking changes

All 0.1.0 exports are preserved. `DbClient` remains exported from
`tracking/agent-run-tracker.js`; `DbPort` is an alias.

## [0.1.0] — 2026-04-23

Initial release. Extracted from `command-center/src/**` (sprints 418-420).

- `AgentLoop` — minimal-loop (multi-provider Anthropic+Groq cascade)
- `SdkAgentLoop` — sdk-loop (Anthropic-direct with permissions)
- `ToolRegistry` — unified contract consumed by both loops
- `AgentRegistry` + `AgentDescriptor` + `agentRegistry.discover()`
- `createBudgetState`, `createCoherenceDetector`
- `createProviderRouter`, `ProviderRouterError`
- `ApprovalChannel`, `InMemoryApprovalStore`
- `sanitizeExternalInput`, `keepSafeOnly`
- `createAgentRunTracker`, `AgentRunTracker`, `DbClient`
- `createBullMQRunner`, `BullMQRunner`
- Agent ID namespace helpers, SDK permissions mapping
