---
classification: C2
product: command-center
status: active
owner: founder
review_due: 2026-12-12
source_repo: command-center
---
# [Feature Name]

**Date**: YYYY-MM-DD
**Author**: [agent-id or username]
**Status**: proposed

---

## Problem

[What gap exists in the SDK that Forge agents have discovered? Be specific — cite agent names, use cases, and the workaround currently in place.]

## Proposed Interface

[TypeScript interface or function signature. This is the contract you're proposing to add to `@vauban-org/agent-sdk`.]

```typescript
// Proposed addition to src/ports/ or src/orchestration/ooda/
```

## Generic Justification

[Why does this belong in the SDK (not in Forge)? Which other agents or future use cases would benefit? How does this generalize beyond the specific Forge use case?]

## Usage Example (from Forge)

[How would a Forge agent consume this? Show before/after if replacing a workaround.]

## Breaking Change Assessment

- [ ] Non-breaking (new export, additive)
- [ ] Breaking (signature change, removal, semantic change)
  - Migration path:
  - Affected consumers:

## Size Impact

Estimated gzipped size impact on SDK bundle: `[X] KB`

## Test Coverage

[Test strategy: unit tests, contract tests, integration tests.]

## References

- [Related ADR or spec]
- [Related Brain entry]
