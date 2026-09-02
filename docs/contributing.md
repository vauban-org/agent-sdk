---
classification: C0
product: command-center
status: active
owner: founder
review_due: 2026-12-12
source_repo: command-center
---
# Contributing to @vauban-org/agent-sdk

## Development setup

```bash
git clone https://github.com/vauban-org/command-center.git
cd command-center
pnpm install
cd packages/agent-sdk
pnpm build
pnpm test
```

## Quality gates

All PRs must pass:

```bash
pnpm lint     # Biome — zero warnings permitted
pnpm build    # TypeScript strict — no `any`, no type errors
pnpm test     # Vitest — full suite, no skipped tests
```

No `// TODO` without a sprint task ref. No commented-out code. No debug artifacts.

---

## SDK Consumer Matrix CI

**Every PR modifying `packages/agent-sdk/**` must pass the 6-consumer matrix CI before merge (`sdk-consumer-matrix.yml` workflow).**

This workflow:
1. Builds the SDK from the PR branch
2. Installs the built package into 6 consumer test harnesses (CC, Forge, Brain, Citadel, Vauban Finance, external SaaS stub)
3. Runs the contract test suite for each consumer against the new build
4. Fails the PR if any consumer breaks

This prevents silent regression: a refactor that compiles fine but breaks a downstream import.

To run the matrix locally (requires Docker):

```bash
pnpm run matrix:ci
```

Each consumer is an isolated pnpm workspace. Contract tests live in `packages/agent-sdk/src/testing/contracts/`.

---

## Contract tests

The SDK ships contract tests for all ports. Any new port **must** include a contract test before merge.

```bash
# Run contract tests only
pnpm test -- tests/contracts/
```

Contract test files:
- `src/testing/contracts/brain-port.contract.ts` — `BrainPort` conformance
- `src/testing/contracts/event-bus.contract.ts` — `EventBusPort` conformance
- `src/testing/contracts/economic-observer.contract.ts` — `EconomyRouter` + `OutcomeTracker`

To test your custom adapter against the port contract:

```typescript
import { brainPortContract } from "@vauban-org/agent-sdk/testing";

describe("MyCustomBrainAdapter", () => {
  brainPortContract(() => new MyCustomBrainAdapter());
});
```

---

## Semver discipline

The SDK follows strict semver. Breaking changes require a major bump.

| Change | Bump |
|--------|------|
| New export (type or value) | minor |
| New optional field on existing type | minor |
| Bug fix, performance improvement | patch |
| Removing an export | **major** |
| Changing a method signature | **major** |
| Removing an optional field | **major** |

**No breaking change without a migration guide** in `docs/migration/`. Update the guide file name to reflect the new version range.

---

## Adding a new port

1. Create `src/ports/<name>.ts` — define the interface, doc every method
2. Create at least one in-memory adapter in `src/adapters/<category>/<name>-memory.ts`
3. Export from `src/ports/index.ts` and `src/index.ts`
4. Write a contract test in `src/testing/contracts/<name>.contract.ts`
5. Document in `docs/ports/<name>.md` (interface quote + ≥1 adapter example)
6. Update `mkdocs.yml` nav

---

## Adding a new tier template

1. Create `src/templates/<tier>-agent.ts`
2. Export from `src/templates/index.ts` and `src/index.ts`
3. Document in `docs/templates.md` with a full working example
4. Write tests in `tests/templates/<tier>-agent.test.ts`

---

## Publishing

The SDK is published to GitHub Container Registry (GHCR):

```bash
pnpm build && pnpm publish --registry https://npm.pkg.github.com
```

Automated on tag `sdk-v*` via `.github/workflows/sdk-publish.yml`. Requires `write:packages` scope.

---

## OODA agent security requirements

Agents consuming the SDK must comply with:

- Input sanitization via `sanitizeExternalInput()` at system boundaries
- No `any` types — use `unknown` with type guards
- Cross-product events signed via `signEvent()` (no raw `crypto.createHmac`)
- HITL for all actions with `estimatedCostCents > 0` in live mode
- No secrets in code — env vars only, never committed

---

## Brain archival after substantive changes

After resolving an ADR-worthy decision or discovering a reusable pattern while working on the SDK, archive to Brain MCP with `category: "development"` or `category: "decision"`. One subject per entry (50–200 words).
