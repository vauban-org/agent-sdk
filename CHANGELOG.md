# Changelog — @vauban-org/agent-sdk

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
