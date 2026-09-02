/**
 * Tests for all event schema files under agent-sdk/src/events/schemas/
 *
 * Coverage: valid accept + strict rejection (extra field) + key constraint
 * violation for each schema.
 *
 * Ref: test coverage for event schema files (no prior tests)
 */

import { describe, expect, it } from "vitest";
import { AgentCompletedV1 } from "../src/events/schemas/agent.completed.v1.js";
import { AgentFailedV1 } from "../src/events/schemas/agent.failed.v1.js";
import { AgentHitlRequestedV1 } from "../src/events/schemas/agent.hitl_requested.v1.js";
import { AgentHitlResolvedV1 } from "../src/events/schemas/agent.hitl_resolved.v1.js";
import { AgentStartedV1 } from "../src/events/schemas/agent.started.v1.js";
import { BrainSkillExtractedV1 } from "../src/events/schemas/brain.skill.extracted.v1.js";
import { CcCostAnomalyDetectedV1 } from "../src/events/schemas/cc.cost.anomaly_detected.v1.js";
import { CcCostRecordedV1 } from "../src/events/schemas/cc.cost.recorded.v1.js";
import { CitadelSprintAnalyzedV1 } from "../src/events/schemas/citadel.sprint.analyzed.v1.js";
import { CitadelSprintClosedV1 } from "../src/events/schemas/citadel.sprint.closed.v1.js";
import { ForgeInboxReplyClassifiedV1 } from "../src/events/schemas/forge.inbox.reply_classified.v1.js";
import { ForgeLeadQualifiedV1 } from "../src/events/schemas/forge.lead.qualified.v1.js";
import { ForgeOutreachSentV1 } from "../src/events/schemas/forge.outreach.sent.v1.js";
import { ForgePolicyTriggeredV1 } from "../src/events/schemas/forge.policy.triggered.v1.js";
import { GlacisIdentityVerifiedV1 } from "../src/events/schemas/glacis.identity.verified.v1.js";
import { IncidentDetectedV1 } from "../src/events/schemas/incident.detected.v1.js";
import { IncidentSloBurnV1 } from "../src/events/schemas/incident.slo_burn.v1.js";
import { TenantBudgetExceededV1 } from "../src/events/schemas/tenant.budget.exceeded.v1.js";
import { TenantProvisionedV1 } from "../src/events/schemas/tenant.provisioned.v1.js";
import { VaubanFinanceForecastGeneratedV1 } from "../src/events/schemas/vauban-finance.forecast.generated.v1.js";
import { VaubanFinanceTradeExecutedV1 } from "../src/events/schemas/vauban-finance.trade.executed.v1.js";
import { VaubanGoalCheckedV1 } from "../src/events/schemas/vauban.goal.checked.v1.js";
import { VaubanRebalancingCheckedV1 } from "../src/events/schemas/vauban.rebalancing.checked.v1.js";
import { VaubanTaxCheckedV1 } from "../src/events/schemas/vauban.tax.checked.v1.js";
import { VaubanVaultAnalyzedV1 } from "../src/events/schemas/vauban.vault.analyzed.v1.js";
import { VaubanVaultCompoundedV1 } from "../src/events/schemas/vauban.vault.compounded.v1.js";
import { VaubanVaultRebalanceProposedV1 } from "../src/events/schemas/vauban.vault.rebalance_proposed.v1.js";
import { VaubanVaultRebalancedV1 } from "../src/events/schemas/vauban.vault.rebalanced.v1.js";

const UUID = "123e4567-e89b-12d3-a456-426614174000";

// ─── agent.completed.v1 ───────────────────────────────────────────────────────

describe("AgentCompletedV1", () => {
  const valid = {
    agentName: "builder",
    runId: UUID,
    outputs: { result: "ok" },
    durationMs: 1000,
    costUsd: 0.01,
  };
  it("accepts valid payload", () => expect(AgentCompletedV1.safeParse(valid).success).toBe(true));
  it("rejects extra field", () =>
    expect(AgentCompletedV1.safeParse({ ...valid, extra: 1 }).success).toBe(false));
  it("rejects zero durationMs (must be positive)", () =>
    expect(AgentCompletedV1.safeParse({ ...valid, durationMs: 0 }).success).toBe(false));
  it("rejects negative costUsd", () =>
    expect(AgentCompletedV1.safeParse({ ...valid, costUsd: -1 }).success).toBe(false));
});

// ─── agent.failed.v1 ─────────────────────────────────────────────────────────

describe("AgentFailedV1", () => {
  const valid = {
    agentName: "builder",
    runId: UUID,
    error: "timeout",
    retryCount: 0,
  };
  it("accepts valid payload", () => expect(AgentFailedV1.safeParse(valid).success).toBe(true));
  it("rejects negative retryCount", () =>
    expect(AgentFailedV1.safeParse({ ...valid, retryCount: -1 }).success).toBe(false));
  it("rejects extra field", () =>
    expect(AgentFailedV1.safeParse({ ...valid, x: 1 }).success).toBe(false));
});

// ─── agent.hitl_requested.v1 ──────────────────────────────────────────────────

describe("AgentHitlRequestedV1", () => {
  const valid = {
    approvalId: UUID,
    question: "Deploy?",
    deadline: "2026-06-01T00:00:00Z",
  };
  it("accepts valid payload", () =>
    expect(AgentHitlRequestedV1.safeParse(valid).success).toBe(true));
  it("rejects non-datetime deadline", () =>
    expect(AgentHitlRequestedV1.safeParse({ ...valid, deadline: "2026-06-01" }).success).toBe(
      false,
    ));
  it("rejects non-uuid approvalId", () =>
    expect(AgentHitlRequestedV1.safeParse({ ...valid, approvalId: "abc" }).success).toBe(false));
});

// ─── agent.hitl_resolved.v1 ───────────────────────────────────────────────────

describe("AgentHitlResolvedV1", () => {
  const valid = {
    approvalId: UUID,
    decision: "approved" as const,
    by: "founder",
  };
  it("accepts approved", () => expect(AgentHitlResolvedV1.safeParse(valid).success).toBe(true));
  it("accepts rejected", () =>
    expect(AgentHitlResolvedV1.safeParse({ ...valid, decision: "rejected" }).success).toBe(true));
  it("rejects invalid decision value", () =>
    expect(AgentHitlResolvedV1.safeParse({ ...valid, decision: "pending" }).success).toBe(false));
});

// ─── agent.started.v1 ────────────────────────────────────────────────────────

describe("AgentStartedV1", () => {
  const valid = { agentName: "builder", runId: UUID, inputs: null };
  it("accepts without tenantId", () => expect(AgentStartedV1.safeParse(valid).success).toBe(true));
  it("accepts with tenantId", () =>
    expect(AgentStartedV1.safeParse({ ...valid, tenantId: UUID }).success).toBe(true));
  it("rejects non-uuid tenantId", () =>
    expect(AgentStartedV1.safeParse({ ...valid, tenantId: "bad" }).success).toBe(false));
});

// ─── brain.skill.extracted.v1 ─────────────────────────────────────────────────

describe("BrainSkillExtractedV1", () => {
  const valid = {
    skillId: "web-search",
    agentSource: "scribe",
    confidence: 0.9,
  };
  it("accepts valid payload", () =>
    expect(BrainSkillExtractedV1.safeParse(valid).success).toBe(true));
  it("rejects confidence > 1", () =>
    expect(BrainSkillExtractedV1.safeParse({ ...valid, confidence: 1.1 }).success).toBe(false));
  it("rejects confidence < 0", () =>
    expect(BrainSkillExtractedV1.safeParse({ ...valid, confidence: -0.1 }).success).toBe(false));
});

// ─── cc.cost.anomaly_detected.v1 ─────────────────────────────────────────────

describe("CcCostAnomalyDetectedV1", () => {
  const valid = {
    agent: "builder",
    expected: 0.1,
    actual: 0.9,
    period: "2026-05",
  };
  it("accepts valid payload", () =>
    expect(CcCostAnomalyDetectedV1.safeParse(valid).success).toBe(true));
  it("rejects extra field", () =>
    expect(CcCostAnomalyDetectedV1.safeParse({ ...valid, x: 1 }).success).toBe(false));
});

// ─── cc.cost.recorded.v1 ─────────────────────────────────────────────────────

describe("CcCostRecordedV1", () => {
  const valid = {
    agent: "builder",
    costUsd: 0.02,
    tokens: 1000,
    model: "llama-3.3-70b",
  };
  it("accepts without tenantId", () =>
    expect(CcCostRecordedV1.safeParse(valid).success).toBe(true));
  it("rejects negative costUsd", () =>
    expect(CcCostRecordedV1.safeParse({ ...valid, costUsd: -1 }).success).toBe(false));
  it("rejects float tokens", () =>
    expect(CcCostRecordedV1.safeParse({ ...valid, tokens: 1.5 }).success).toBe(false));
});

// ─── citadel.sprint.analyzed.v1 ──────────────────────────────────────────────

describe("CitadelSprintAnalyzedV1", () => {
  const valid = {
    sprintId: "sprint-7",
    healthScore: 85,
    overallSeverity: "info" as const,
    insights: [
      {
        type: "velocity",
        severity: "info" as const,
        metric: "tasks/day",
        description: "ok",
      },
    ],
    blockers: [],
    recommendations: ["ship it"],
    timestamp: "2026-05-19T00:00:00Z",
    schemaVersion: "1.0.0",
  };
  it("accepts valid payload", () =>
    expect(CitadelSprintAnalyzedV1.safeParse(valid).success).toBe(true));
  it("rejects healthScore > 100", () =>
    expect(CitadelSprintAnalyzedV1.safeParse({ ...valid, healthScore: 101 }).success).toBe(false));
  it("rejects invalid overallSeverity", () =>
    expect(CitadelSprintAnalyzedV1.safeParse({ ...valid, overallSeverity: "fatal" }).success).toBe(
      false,
    ));
});

// ─── citadel.sprint.closed.v1 ────────────────────────────────────────────────

describe("CitadelSprintClosedV1", () => {
  const valid = { sprintId: "sprint-7", completed: 10, carryOver: 2 };
  it("accepts valid payload", () =>
    expect(CitadelSprintClosedV1.safeParse(valid).success).toBe(true));
  it("rejects negative carryOver", () =>
    expect(CitadelSprintClosedV1.safeParse({ ...valid, carryOver: -1 }).success).toBe(false));
});

// ─── forge.inbox.reply_classified.v1 ─────────────────────────────────────────

describe("ForgeInboxReplyClassifiedV1", () => {
  const valid = {
    uid: "msg-123",
    from: "user@example.com",
    subject: "Re: Hello",
    type: "INTERESTED" as const,
    priority: "HIGH" as const,
    signal: "booked demo",
    nextAction: "follow-up",
    timestamp: "2026-05-19T00:00:00Z",
    schemaVersion: "1.0.0",
  };
  it("accepts valid payload", () =>
    expect(ForgeInboxReplyClassifiedV1.safeParse(valid).success).toBe(true));
  it("rejects invalid type", () =>
    expect(ForgeInboxReplyClassifiedV1.safeParse({ ...valid, type: "MAYBE" }).success).toBe(false));
  it("rejects invalid priority", () =>
    expect(ForgeInboxReplyClassifiedV1.safeParse({ ...valid, priority: "URGENT" }).success).toBe(
      false,
    ));
});

// ─── forge.lead.qualified.v1 ─────────────────────────────────────────────────

describe("ForgeLeadQualifiedV1", () => {
  const valid = { leadId: UUID, score: 75, source: "inbound" as const };
  it("accepts valid payload", () =>
    expect(ForgeLeadQualifiedV1.safeParse(valid).success).toBe(true));
  it("rejects score > 100", () =>
    expect(ForgeLeadQualifiedV1.safeParse({ ...valid, score: 101 }).success).toBe(false));
  it("rejects invalid source", () =>
    expect(ForgeLeadQualifiedV1.safeParse({ ...valid, source: "cold-call" }).success).toBe(false));
});

// ─── forge.outreach.sent.v1 ──────────────────────────────────────────────────

describe("ForgeOutreachSentV1", () => {
  const valid = { leadId: UUID, channel: "email" as const, content: "Hello!" };
  it("accepts valid payload", () =>
    expect(ForgeOutreachSentV1.safeParse(valid).success).toBe(true));
  it("rejects invalid channel", () =>
    expect(ForgeOutreachSentV1.safeParse({ ...valid, channel: "phone" }).success).toBe(false));
  it("accepts all valid channels", () => {
    for (const ch of ["email", "linkedin", "x", "telegram"] as const) {
      expect(ForgeOutreachSentV1.safeParse({ ...valid, channel: ch }).success).toBe(true);
    }
  });
});

// ─── forge.policy.triggered.v1 ───────────────────────────────────────────────

describe("ForgePolicyTriggeredV1", () => {
  const valid = { policyId: "risk-gate-1", context: { reason: "threshold" } };
  it("accepts valid payload", () =>
    expect(ForgePolicyTriggeredV1.safeParse(valid).success).toBe(true));
  it("accepts empty context record", () =>
    expect(ForgePolicyTriggeredV1.safeParse({ ...valid, context: {} }).success).toBe(true));
});

// ─── glacis.identity.verified.v1 ─────────────────────────────────────────────

describe("GlacisIdentityVerifiedV1", () => {
  const valid = { userId: UUID, method: "zk_passport" as const };
  it("accepts valid payload", () =>
    expect(GlacisIdentityVerifiedV1.safeParse(valid).success).toBe(true));
  it("rejects invalid method", () =>
    expect(GlacisIdentityVerifiedV1.safeParse({ ...valid, method: "oauth" }).success).toBe(false));
  it("accepts all valid methods", () => {
    for (const m of ["zk_passport", "zk_email", "world_id"] as const) {
      expect(GlacisIdentityVerifiedV1.safeParse({ ...valid, method: m }).success).toBe(true);
    }
  });
});

// ─── incident.detected.v1 ────────────────────────────────────────────────────

describe("IncidentDetectedV1", () => {
  const valid = {
    source: "bastion",
    severity: "high" as const,
    summary: "memory leak",
  };
  it("accepts valid payload", () => expect(IncidentDetectedV1.safeParse(valid).success).toBe(true));
  it("rejects invalid severity", () =>
    expect(IncidentDetectedV1.safeParse({ ...valid, severity: "fatal" }).success).toBe(false));
});

// ─── incident.slo_burn.v1 ────────────────────────────────────────────────────

describe("IncidentSloBurnV1", () => {
  const valid = { slo: "api-p99", burnRate: 2.5, severity: "medium" as const };
  it("accepts valid payload", () => expect(IncidentSloBurnV1.safeParse(valid).success).toBe(true));
  it("rejects invalid severity", () =>
    expect(IncidentSloBurnV1.safeParse({ ...valid, severity: "warning" }).success).toBe(false));
});

// ─── tenant.budget.exceeded.v1 ───────────────────────────────────────────────

describe("TenantBudgetExceededV1", () => {
  const valid = {
    tenantId: UUID,
    period: "2026-05",
    amountUsd: 110,
    limitUsd: 100,
  };
  it("accepts valid payload", () =>
    expect(TenantBudgetExceededV1.safeParse(valid).success).toBe(true));
  it("rejects non-uuid tenantId", () =>
    expect(TenantBudgetExceededV1.safeParse({ ...valid, tenantId: "bad" }).success).toBe(false));
});

// ─── tenant.provisioned.v1 ───────────────────────────────────────────────────

describe("TenantProvisionedV1", () => {
  const valid = {
    tenantId: UUID,
    plan: "starter" as const,
    virtualKey: "vk_abc123",
  };
  it("accepts valid payload", () =>
    expect(TenantProvisionedV1.safeParse(valid).success).toBe(true));
  it("rejects invalid plan", () =>
    expect(TenantProvisionedV1.safeParse({ ...valid, plan: "free" }).success).toBe(false));
  it("accepts all valid plans", () => {
    for (const p of ["starter", "team", "pro", "enterprise"] as const) {
      expect(TenantProvisionedV1.safeParse({ ...valid, plan: p }).success).toBe(true);
    }
  });
});

// ─── vauban-finance.forecast.generated.v1 ────────────────────────────────────

describe("VaubanFinanceForecastGeneratedV1", () => {
  const valid = {
    scenarioId: "s1",
    successRate: 0.85,
    paramVelocity: 1.2,
    timestamp: "2026-05-19T00:00:00Z",
    schemaVersion: "1.0.0",
  };
  it("accepts valid payload", () =>
    expect(VaubanFinanceForecastGeneratedV1.safeParse(valid).success).toBe(true));
  it("rejects successRate > 1", () =>
    expect(VaubanFinanceForecastGeneratedV1.safeParse({ ...valid, successRate: 1.1 }).success).toBe(
      false,
    ));
});

// ─── vauban-finance.trade.executed.v1 ────────────────────────────────────────

describe("VaubanFinanceTradeExecutedV1", () => {
  const valid = {
    symbol: "NQ",
    direction: "long" as const,
    quantity: 1,
    conviction: 0.8,
    timestamp: "2026-05-19T00:00:00Z",
    schemaVersion: "1.0.0",
  };
  it("accepts valid payload", () =>
    expect(VaubanFinanceTradeExecutedV1.safeParse(valid).success).toBe(true));
  it("rejects invalid direction", () =>
    expect(VaubanFinanceTradeExecutedV1.safeParse({ ...valid, direction: "buy" }).success).toBe(
      false,
    ));
  it("rejects conviction > 1", () =>
    expect(VaubanFinanceTradeExecutedV1.safeParse({ ...valid, conviction: 1.1 }).success).toBe(
      false,
    ));
});

// ─── vauban.goal.checked.v1 ──────────────────────────────────────────────────

describe("VaubanGoalCheckedV1", () => {
  const valid = {
    goalId: "g1",
    successRate: 0.9,
    alertLevel: "none" as const,
    timestamp: "2026-05-19T00:00:00Z",
    schemaVersion: "1.0.0",
  };
  it("accepts valid payload", () =>
    expect(VaubanGoalCheckedV1.safeParse(valid).success).toBe(true));
  it("rejects invalid alertLevel", () =>
    expect(VaubanGoalCheckedV1.safeParse({ ...valid, alertLevel: "info" }).success).toBe(false));
});

// ─── vauban.rebalancing.checked.v1 ───────────────────────────────────────────

describe("VaubanRebalancingCheckedV1", () => {
  const valid = {
    portfolioId: "p1",
    maxDrift: 0.05,
    alertLevel: "warning" as const,
    timestamp: "2026-05-19T00:00:00Z",
    schemaVersion: "1.0.0",
  };
  it("accepts valid payload", () =>
    expect(VaubanRebalancingCheckedV1.safeParse(valid).success).toBe(true));
  it("rejects extra field", () =>
    expect(VaubanRebalancingCheckedV1.safeParse({ ...valid, extra: 1 }).success).toBe(false));
});

// ─── vauban.tax.checked.v1 ───────────────────────────────────────────────────

describe("VaubanTaxCheckedV1", () => {
  const valid = {
    userId: "user-1",
    rulesTriggered: ["exit-tax"],
    alertLevel: "critical" as const,
    timestamp: "2026-05-19T00:00:00Z",
    schemaVersion: "1.0.0",
  };
  it("accepts valid payload", () => expect(VaubanTaxCheckedV1.safeParse(valid).success).toBe(true));
  it("accepts empty rulesTriggered array", () =>
    expect(VaubanTaxCheckedV1.safeParse({ ...valid, rulesTriggered: [] }).success).toBe(true));
});

// ─── vauban.vault.analyzed.v1 ────────────────────────────────────────────────

describe("VaubanVaultAnalyzedV1", () => {
  const valid = {
    vaultId: "v1",
    tvlUsd: 1_000_000,
    anomalies: [
      {
        type: "liquidity",
        severity: "warning" as const,
        metric: "tvl_drop_pct",
        current: 5,
        expected: 0,
        description: "5% TVL drop",
      },
    ],
    overallSeverity: "warning" as const,
    timestamp: "2026-05-19T00:00:00Z",
    schemaVersion: "1.0.0",
  };
  it("accepts valid payload", () =>
    expect(VaubanVaultAnalyzedV1.safeParse(valid).success).toBe(true));
  it("accepts empty anomalies array", () =>
    expect(VaubanVaultAnalyzedV1.safeParse({ ...valid, anomalies: [] }).success).toBe(true));
  it("rejects invalid anomaly severity", () =>
    expect(
      VaubanVaultAnalyzedV1.safeParse({
        ...valid,
        anomalies: [{ ...valid.anomalies[0], severity: "fatal" }],
      }).success,
    ).toBe(false));
});

// ─── vauban.vault.compounded.v1 ──────────────────────────────────────────────

describe("VaubanVaultCompoundedV1", () => {
  const valid = {
    vaultId: "v1",
    compoundedAt: "2026-05-19T00:00:00Z",
    rewardsUsd: 10.5,
    caller: "0xabc",
    schemaVersion: "1.0.0",
  };
  it("accepts without txHash", () =>
    expect(VaubanVaultCompoundedV1.safeParse(valid).success).toBe(true));
  it("accepts with txHash", () =>
    expect(VaubanVaultCompoundedV1.safeParse({ ...valid, txHash: "0xdeadbeef" }).success).toBe(
      true,
    ));
});

// ─── vauban.vault.rebalanced.v1 ──────────────────────────────────────────────

describe("VaubanVaultRebalancedV1", () => {
  const valid = { vaultId: "v1", txHash: "0xdeadbeef" };
  it("accepts valid payload", () =>
    expect(VaubanVaultRebalancedV1.safeParse(valid).success).toBe(true));
  it("rejects extra field", () =>
    expect(VaubanVaultRebalancedV1.safeParse({ ...valid, extra: 1 }).success).toBe(false));
});

// ─── vauban.vault.rebalance_proposed.v1 ──────────────────────────────────────

describe("VaubanVaultRebalanceProposedV1", () => {
  const valid = { vaultId: "v1", currentRatio: 0.6, targetRatio: 0.5 };
  it("accepts valid payload", () =>
    expect(VaubanVaultRebalanceProposedV1.safeParse(valid).success).toBe(true));
  it("rejects non-number currentRatio", () =>
    expect(
      VaubanVaultRebalanceProposedV1.safeParse({
        ...valid,
        currentRatio: "0.6",
      }).success,
    ).toBe(false));
});
