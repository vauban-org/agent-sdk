---
classification: C2
product: command-center
status: active
owner: founder
review_due: 2026-12-12
source_repo: command-center
---
# `@vauban-org/agent-sdk` — Orchestration Patterns (v0.9.0)

3 patterns composables, indépendants. S'intègrent dans le cycle OODA sans
modifier `OODAAgentImpl`.

---

## Pattern A — SessionCircuitBreaker

```ts
import { createSessionCircuitBreaker } from '@vauban-org/agent-sdk/patterns/circuit-breaker';
```

Track les métriques de session OODA et coupe l'exécution si un seuil est
dépassé. S'intègre comme `RiskGuard` (`OODAAgentConfig.riskGuards`).

**IMPORTANT** : les méthodes `record*` doivent être appelées manuellement
depuis les phase functions — le SDK ne les alimente pas automatiquement.

**Distinct de** `resilience/circuitBreaker` (qui wraps des fonctions async).

### Thresholds (defaults)

| Seuil | Default |
|---|---|
| `maxTokens` | 50 000 |
| `maxConsecutiveErrors` | 5 — trips ON the Nth error (>= comparison) |
| `maxActionCount` | 200 |
| `maxElapsedMs` | 3 600 000 ms (1h) |
| `maxCostUsd` | $10.00 |
| `resetAfterMs` | 60 000 ms |

### State machine

`closed` → `open` (seuil dépassé) → `half-open` (après `resetAfterMs`) → `closed` (probe success)

### Usage

```ts
const cb = createSessionCircuitBreaker({
  name: 'trading-session',
  thresholds: { maxConsecutiveErrors: 3, maxCostUsd: 5.0 },
  onTrip: (snap) => ctx.notifySlack('#alerts', `CB tripped: ${snap.tripReason}`),
});
// Dans les phase functions :
cb.recordTokens(500, 0.002);
cb.recordAction();
// cb.recordError() si la phase échoue
// cb.recordSuccess() si la phase réussit
// OODAAgentConfig :
// riskGuards: [cb]
```

---

## Pattern B — QualityGate

```ts
import { createQualityGate } from '@vauban-org/agent-sdk/patterns/quality-gate';
```

Évalue la qualité d'un output OODA via des evaluators pondérés (score 0..1).
Route vers `auto`, `async_review`, ou `hitl_block` selon les seuils.
NaN/Infinity retournés par un evaluator sont traités comme 0 (pas de propagation).

### Routing (thresholds configurables)

| Score | Routing | Default |
|---|---|---|
| >= `autoProceedThreshold` | `auto` | 0.8 |
| >= `asyncReviewThreshold` | `async_review` | 0.5 |
| < `asyncReviewThreshold` | `hitl_block` | — |

### Usage (dans la phase `act`)

```ts
const gate = createQualityGate({
  name: 'trade-signal-quality',
  evaluators: [
    { name: 'confidence', weight: 2, evaluate: async (s) => s.confidence },
    { name: 'completeness', weight: 1, evaluate: async (s) => s.fields / s.total },
  ],
  onHitlBlock: (score, subject) => ctx.notifySlack('#alerts', `Quality gate blocked: ${score.overall.toFixed(2)}`),
});
const score = await gate.evaluate(decisionPayload);
if (score.routing === 'hitl_block') return; // abort act phase
```

---

## Pattern C — EscalationPyramid

```ts
import { createEscalationPyramid } from '@vauban-org/agent-sdk/patterns/escalation';
```

Déclare les niveaux d'autonomie par type d'action. Escalade automatiquement
si la confiance est insuffisante. Types inconnus → L3 (fail-safe).

**NOTE** : `confidence` doit être fourni par la phase DECIDE de l'agent.

### Niveaux

| Level | Comportement |
|---|---|
| `L1_autonomous` | Exécution directe |
| `L2_async_review` | Exécution + review asynchrone |
| `L3_hitl_required` | Bloque jusqu'à validation humaine |

### Escalade par confiance (thresholds configurables)

| Déclaré | Condition | Effectif |
|---|---|---|
| L1 | confidence < 0.85 | L2 |
| L2 | confidence < 0.60 | L3 |
| L3 | tout | L3 |
| tout | dry-run | L1 |
| inconnu | tout | L3 |

### Usage

```ts
const pyramid = createEscalationPyramid({
  name: 'trading-pyramid',
  declarations: [
    { actionType: 'read_portfolio',    level: 'L1_autonomous' },
    { actionType: 'place_limit_order', level: 'L2_async_review' },
    { actionType: 'place_market_order',level: 'L3_hitl_required' },
  ],
  onHitlRequired: (actionType, confidence, decision, ctx) =>
    ctx.notifySlack('#trading-hitl', `${actionType} requires approval`),
});
const decision = await pyramid.canProceed('place_limit_order', 0.75, ctx);
if (!decision.proceed) return;
// Runtime override (sans redéploiement) :
pyramid.override('place_limit_order', 'L3_hitl_required');
pyramid.clearOverride('place_limit_order');
```
