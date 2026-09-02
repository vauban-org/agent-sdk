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

const UUID = "00000000-0000-4000-8000-000000000000";
const TS = "2026-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// AgentCompletedV1
// ---------------------------------------------------------------------------
describe("AgentCompletedV1", () => {
  it("accepts a valid payload", () => {
    expect(
      AgentCompletedV1.safeParse({
        agentName: "builder",
        runId: UUID,
        outputs: null,
        durationMs: 1000,
        costUsd: 0.05,
      }).success,
    ).toBe(true);
  });

  it("accepts outputs as an object", () => {
    expect(
      AgentCompletedV1.safeParse({
        agentName: "builder",
        runId: UUID,
        outputs: { result: "ok" },
        durationMs: 1,
        costUsd: 0,
      }).success,
    ).toBe(true);
  });

  it("rejects empty object", () => {
    expect(AgentCompletedV1.safeParse({}).success).toBe(false);
  });

  it("rejects missing agentName", () => {
    expect(
      AgentCompletedV1.safeParse({
        runId: UUID,
        outputs: null,
        durationMs: 1,
        costUsd: 0,
      }).success,
    ).toBe(false);
  });

  it("rejects non-uuid runId", () => {
    expect(
      AgentCompletedV1.safeParse({
        agentName: "x",
        runId: "not-a-uuid",
        outputs: null,
        durationMs: 1,
        costUsd: 0,
      }).success,
    ).toBe(false);
  });

  it("rejects negative durationMs", () => {
    expect(
      AgentCompletedV1.safeParse({
        agentName: "x",
        runId: UUID,
        outputs: null,
        durationMs: -1,
        costUsd: 0,
      }).success,
    ).toBe(false);
  });

  it("rejects negative costUsd", () => {
    expect(
      AgentCompletedV1.safeParse({
        agentName: "x",
        runId: UUID,
        outputs: null,
        durationMs: 1,
        costUsd: -0.01,
      }).success,
    ).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      AgentCompletedV1.safeParse({
        agentName: "x",
        runId: UUID,
        outputs: null,
        durationMs: 1,
        costUsd: 0,
        extra: "field",
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AgentFailedV1
// ---------------------------------------------------------------------------
describe("AgentFailedV1", () => {
  it("accepts a valid payload", () => {
    expect(
      AgentFailedV1.safeParse({
        agentName: "builder",
        runId: UUID,
        error: "timeout",
        retryCount: 2,
      }).success,
    ).toBe(true);
  });

  it("accepts retryCount=0", () => {
    expect(
      AgentFailedV1.safeParse({
        agentName: "builder",
        runId: UUID,
        error: "OOM",
        retryCount: 0,
      }).success,
    ).toBe(true);
  });

  it("rejects empty object", () => {
    expect(AgentFailedV1.safeParse({}).success).toBe(false);
  });

  it("rejects negative retryCount", () => {
    expect(
      AgentFailedV1.safeParse({
        agentName: "x",
        runId: UUID,
        error: "err",
        retryCount: -1,
      }).success,
    ).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      AgentFailedV1.safeParse({
        agentName: "x",
        runId: UUID,
        error: "err",
        retryCount: 0,
        extra: true,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AgentHitlRequestedV1
// ---------------------------------------------------------------------------
describe("AgentHitlRequestedV1", () => {
  it("accepts a valid payload", () => {
    expect(
      AgentHitlRequestedV1.safeParse({
        approvalId: UUID,
        question: "Approve deploy?",
        deadline: TS,
      }).success,
    ).toBe(true);
  });

  it("rejects empty object", () => {
    expect(AgentHitlRequestedV1.safeParse({}).success).toBe(false);
  });

  it("rejects non-uuid approvalId", () => {
    expect(
      AgentHitlRequestedV1.safeParse({
        approvalId: "bad",
        question: "q",
        deadline: TS,
      }).success,
    ).toBe(false);
  });

  it("rejects non-datetime deadline", () => {
    expect(
      AgentHitlRequestedV1.safeParse({
        approvalId: UUID,
        question: "q",
        deadline: "not-a-date",
      }).success,
    ).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      AgentHitlRequestedV1.safeParse({
        approvalId: UUID,
        question: "q",
        deadline: TS,
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AgentHitlResolvedV1
// ---------------------------------------------------------------------------
describe("AgentHitlResolvedV1", () => {
  it("accepts approved decision", () => {
    expect(
      AgentHitlResolvedV1.safeParse({
        approvalId: UUID,
        decision: "approved",
        by: "alice",
      }).success,
    ).toBe(true);
  });

  it("accepts rejected decision", () => {
    expect(
      AgentHitlResolvedV1.safeParse({
        approvalId: UUID,
        decision: "rejected",
        by: "bob",
      }).success,
    ).toBe(true);
  });

  it("rejects invalid decision value", () => {
    expect(
      AgentHitlResolvedV1.safeParse({
        approvalId: UUID,
        decision: "pending",
        by: "x",
      }).success,
    ).toBe(false);
  });

  it("rejects empty object", () => {
    expect(AgentHitlResolvedV1.safeParse({}).success).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      AgentHitlResolvedV1.safeParse({
        approvalId: UUID,
        decision: "approved",
        by: "x",
        extra: true,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AgentStartedV1
// ---------------------------------------------------------------------------
describe("AgentStartedV1", () => {
  it("accepts minimal valid payload", () => {
    expect(
      AgentStartedV1.safeParse({
        agentName: "builder",
        runId: UUID,
        inputs: null,
      }).success,
    ).toBe(true);
  });

  it("accepts optional tenantId", () => {
    expect(
      AgentStartedV1.safeParse({
        agentName: "builder",
        runId: UUID,
        inputs: { task: "do x" },
        tenantId: UUID,
      }).success,
    ).toBe(true);
  });

  it("rejects invalid tenantId format", () => {
    expect(
      AgentStartedV1.safeParse({
        agentName: "x",
        runId: UUID,
        inputs: null,
        tenantId: "not-uuid",
      }).success,
    ).toBe(false);
  });

  it("rejects empty object", () => {
    expect(AgentStartedV1.safeParse({}).success).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      AgentStartedV1.safeParse({
        agentName: "x",
        runId: UUID,
        inputs: null,
        unknown: "field",
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BrainSkillExtractedV1
// ---------------------------------------------------------------------------
describe("BrainSkillExtractedV1", () => {
  it("accepts valid payload", () => {
    expect(
      BrainSkillExtractedV1.safeParse({
        skillId: "web-search",
        agentSource: "builder",
        confidence: 0.9,
      }).success,
    ).toBe(true);
  });

  it("accepts confidence=0 and confidence=1 boundaries", () => {
    expect(
      BrainSkillExtractedV1.safeParse({
        skillId: "x",
        agentSource: "y",
        confidence: 0,
      }).success,
    ).toBe(true);
    expect(
      BrainSkillExtractedV1.safeParse({
        skillId: "x",
        agentSource: "y",
        confidence: 1,
      }).success,
    ).toBe(true);
  });

  it("rejects confidence above 1", () => {
    expect(
      BrainSkillExtractedV1.safeParse({
        skillId: "x",
        agentSource: "y",
        confidence: 1.1,
      }).success,
    ).toBe(false);
  });

  it("rejects confidence below 0", () => {
    expect(
      BrainSkillExtractedV1.safeParse({
        skillId: "x",
        agentSource: "y",
        confidence: -0.1,
      }).success,
    ).toBe(false);
  });

  it("rejects empty object", () => {
    expect(BrainSkillExtractedV1.safeParse({}).success).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      BrainSkillExtractedV1.safeParse({
        skillId: "x",
        agentSource: "y",
        confidence: 0.5,
        extra: true,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CcCostAnomalyDetectedV1
// ---------------------------------------------------------------------------
describe("CcCostAnomalyDetectedV1", () => {
  it("accepts valid payload", () => {
    expect(
      CcCostAnomalyDetectedV1.safeParse({
        agent: "builder",
        expected: 0.1,
        actual: 0.5,
        period: "2026-01",
      }).success,
    ).toBe(true);
  });

  it("rejects empty object", () => {
    expect(CcCostAnomalyDetectedV1.safeParse({}).success).toBe(false);
  });

  it("rejects missing period", () => {
    expect(
      CcCostAnomalyDetectedV1.safeParse({
        agent: "x",
        expected: 1,
        actual: 2,
      }).success,
    ).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      CcCostAnomalyDetectedV1.safeParse({
        agent: "x",
        expected: 1,
        actual: 2,
        period: "2026-01",
        extra: true,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CcCostRecordedV1
// ---------------------------------------------------------------------------
describe("CcCostRecordedV1", () => {
  it("accepts minimal valid payload", () => {
    expect(
      CcCostRecordedV1.safeParse({
        agent: "builder",
        costUsd: 0.01,
        tokens: 1000,
        model: "llama-3.3-70b",
      }).success,
    ).toBe(true);
  });

  it("accepts optional tenantId", () => {
    expect(
      CcCostRecordedV1.safeParse({
        agent: "builder",
        costUsd: 0,
        tokens: 0,
        model: "x",
        tenantId: UUID,
      }).success,
    ).toBe(true);
  });

  it("rejects negative costUsd", () => {
    expect(
      CcCostRecordedV1.safeParse({
        agent: "x",
        costUsd: -1,
        tokens: 0,
        model: "x",
      }).success,
    ).toBe(false);
  });

  it("rejects negative tokens", () => {
    expect(
      CcCostRecordedV1.safeParse({
        agent: "x",
        costUsd: 0,
        tokens: -1,
        model: "x",
      }).success,
    ).toBe(false);
  });

  it("rejects empty object", () => {
    expect(CcCostRecordedV1.safeParse({}).success).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      CcCostRecordedV1.safeParse({
        agent: "x",
        costUsd: 0,
        tokens: 0,
        model: "x",
        extra: true,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CitadelSprintAnalyzedV1
// ---------------------------------------------------------------------------
describe("CitadelSprintAnalyzedV1", () => {
  const validInsight = {
    type: "velocity_drop",
    severity: "warning" as const,
    metric: "velocity",
    description: "Velocity dropped 30%",
  };

  it("accepts valid payload with insights", () => {
    expect(
      CitadelSprintAnalyzedV1.safeParse({
        sprintId: "sprint-42",
        healthScore: 75,
        overallSeverity: "warning",
        insights: [validInsight],
        blockers: ["task-3"],
        recommendations: ["Focus on unblocked tasks"],
        timestamp: TS,
        schemaVersion: "1.0.0",
      }).success,
    ).toBe(true);
  });

  it("accepts empty arrays for insights, blockers, recommendations", () => {
    expect(
      CitadelSprintAnalyzedV1.safeParse({
        sprintId: "sprint-1",
        healthScore: 100,
        overallSeverity: "info",
        insights: [],
        blockers: [],
        recommendations: [],
        timestamp: TS,
        schemaVersion: "1.0.0",
      }).success,
    ).toBe(true);
  });

  it("rejects healthScore above 100", () => {
    expect(
      CitadelSprintAnalyzedV1.safeParse({
        sprintId: "s",
        healthScore: 101,
        overallSeverity: "info",
        insights: [],
        blockers: [],
        recommendations: [],
        timestamp: TS,
        schemaVersion: "1",
      }).success,
    ).toBe(false);
  });

  it("rejects invalid overallSeverity", () => {
    expect(
      CitadelSprintAnalyzedV1.safeParse({
        sprintId: "s",
        healthScore: 50,
        overallSeverity: "fatal",
        insights: [],
        blockers: [],
        recommendations: [],
        timestamp: TS,
        schemaVersion: "1",
      }).success,
    ).toBe(false);
  });

  it("rejects invalid insight severity", () => {
    expect(
      CitadelSprintAnalyzedV1.safeParse({
        sprintId: "s",
        healthScore: 50,
        overallSeverity: "info",
        insights: [{ ...validInsight, severity: "catastrophic" }],
        blockers: [],
        recommendations: [],
        timestamp: TS,
        schemaVersion: "1",
      }).success,
    ).toBe(false);
  });

  it("rejects empty object", () => {
    expect(CitadelSprintAnalyzedV1.safeParse({}).success).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      CitadelSprintAnalyzedV1.safeParse({
        sprintId: "s",
        healthScore: 50,
        overallSeverity: "info",
        insights: [],
        blockers: [],
        recommendations: [],
        timestamp: TS,
        schemaVersion: "1",
        extra: true,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CitadelSprintClosedV1
// ---------------------------------------------------------------------------
describe("CitadelSprintClosedV1", () => {
  it("accepts valid payload", () => {
    expect(
      CitadelSprintClosedV1.safeParse({
        sprintId: "sprint-7",
        completed: 8,
        carryOver: 2,
      }).success,
    ).toBe(true);
  });

  it("accepts zero values", () => {
    expect(
      CitadelSprintClosedV1.safeParse({
        sprintId: "sprint-0",
        completed: 0,
        carryOver: 0,
      }).success,
    ).toBe(true);
  });

  it("rejects empty object", () => {
    expect(CitadelSprintClosedV1.safeParse({}).success).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      CitadelSprintClosedV1.safeParse({
        sprintId: "s",
        completed: 1,
        carryOver: 0,
        extra: true,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ForgeInboxReplyClassifiedV1
// ---------------------------------------------------------------------------
describe("ForgeInboxReplyClassifiedV1", () => {
  const validBase = {
    uid: "msg-001",
    from: "contact@example.com",
    subject: "Re: Outreach",
    type: "INTERESTED" as const,
    priority: "HIGH" as const,
    signal: "positive",
    nextAction: "schedule_call",
    timestamp: TS,
    schemaVersion: "1.0.0",
  };

  it("accepts valid payload", () => {
    expect(ForgeInboxReplyClassifiedV1.safeParse(validBase).success).toBe(true);
  });

  it("accepts all valid type values", () => {
    const types = ["INTERESTED", "NOT_INTERESTED", "BOUNCE", "SPAM", "OTHER"] as const;
    for (const type of types) {
      expect(ForgeInboxReplyClassifiedV1.safeParse({ ...validBase, type }).success).toBe(true);
    }
  });

  it("accepts all valid priority values", () => {
    const priorities = ["HIGH", "MEDIUM", "LOW"] as const;
    for (const priority of priorities) {
      expect(ForgeInboxReplyClassifiedV1.safeParse({ ...validBase, priority }).success).toBe(true);
    }
  });

  it("rejects invalid type value", () => {
    expect(
      ForgeInboxReplyClassifiedV1.safeParse({
        ...validBase,
        type: "UNKNOWN",
      }).success,
    ).toBe(false);
  });

  it("rejects invalid priority value", () => {
    expect(
      ForgeInboxReplyClassifiedV1.safeParse({
        ...validBase,
        priority: "URGENT",
      }).success,
    ).toBe(false);
  });

  it("rejects empty object", () => {
    expect(ForgeInboxReplyClassifiedV1.safeParse({}).success).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      ForgeInboxReplyClassifiedV1.safeParse({
        ...validBase,
        extra: true,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ForgeLeadQualifiedV1
// ---------------------------------------------------------------------------
describe("ForgeLeadQualifiedV1", () => {
  it("accepts valid payload", () => {
    expect(
      ForgeLeadQualifiedV1.safeParse({
        leadId: UUID,
        score: 85,
        source: "inbound",
      }).success,
    ).toBe(true);
  });

  it("accepts all source values", () => {
    for (const source of ["inbound", "outbound", "referral"] as const) {
      expect(ForgeLeadQualifiedV1.safeParse({ leadId: UUID, score: 50, source }).success).toBe(
        true,
      );
    }
  });

  it("rejects score above 100", () => {
    expect(
      ForgeLeadQualifiedV1.safeParse({
        leadId: UUID,
        score: 101,
        source: "inbound",
      }).success,
    ).toBe(false);
  });

  it("rejects invalid source", () => {
    expect(
      ForgeLeadQualifiedV1.safeParse({
        leadId: UUID,
        score: 50,
        source: "cold",
      }).success,
    ).toBe(false);
  });

  it("rejects empty object", () => {
    expect(ForgeLeadQualifiedV1.safeParse({}).success).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      ForgeLeadQualifiedV1.safeParse({
        leadId: UUID,
        score: 50,
        source: "inbound",
        extra: true,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ForgeOutreachSentV1
// ---------------------------------------------------------------------------
describe("ForgeOutreachSentV1", () => {
  it("accepts valid payload", () => {
    expect(
      ForgeOutreachSentV1.safeParse({
        leadId: UUID,
        channel: "email",
        content: "Hello, let's connect.",
      }).success,
    ).toBe(true);
  });

  it("accepts all channel values", () => {
    for (const channel of ["email", "linkedin", "x", "telegram"] as const) {
      expect(
        ForgeOutreachSentV1.safeParse({
          leadId: UUID,
          channel,
          content: "msg",
        }).success,
      ).toBe(true);
    }
  });

  it("rejects invalid channel", () => {
    expect(
      ForgeOutreachSentV1.safeParse({
        leadId: UUID,
        channel: "sms",
        content: "msg",
      }).success,
    ).toBe(false);
  });

  it("rejects empty object", () => {
    expect(ForgeOutreachSentV1.safeParse({}).success).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      ForgeOutreachSentV1.safeParse({
        leadId: UUID,
        channel: "email",
        content: "msg",
        extra: true,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ForgePolicyTriggeredV1
// ---------------------------------------------------------------------------
describe("ForgePolicyTriggeredV1", () => {
  it("accepts valid payload with context", () => {
    expect(
      ForgePolicyTriggeredV1.safeParse({
        policyId: "rate-limit-v1",
        context: { userId: "u1", action: "send" },
      }).success,
    ).toBe(true);
  });

  it("accepts empty context object", () => {
    expect(
      ForgePolicyTriggeredV1.safeParse({
        policyId: "policy-1",
        context: {},
      }).success,
    ).toBe(true);
  });

  it("rejects missing policyId", () => {
    expect(ForgePolicyTriggeredV1.safeParse({ context: {} }).success).toBe(false);
  });

  it("rejects empty object", () => {
    expect(ForgePolicyTriggeredV1.safeParse({}).success).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      ForgePolicyTriggeredV1.safeParse({
        policyId: "x",
        context: {},
        extra: true,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GlacisIdentityVerifiedV1
// ---------------------------------------------------------------------------
describe("GlacisIdentityVerifiedV1", () => {
  it("accepts zk_passport method", () => {
    expect(
      GlacisIdentityVerifiedV1.safeParse({
        userId: UUID,
        method: "zk_passport",
      }).success,
    ).toBe(true);
  });

  it("accepts all method values", () => {
    for (const method of ["zk_passport", "zk_email", "world_id"] as const) {
      expect(GlacisIdentityVerifiedV1.safeParse({ userId: UUID, method }).success).toBe(true);
    }
  });

  it("rejects invalid method", () => {
    expect(
      GlacisIdentityVerifiedV1.safeParse({
        userId: UUID,
        method: "biometric",
      }).success,
    ).toBe(false);
  });

  it("rejects non-uuid userId", () => {
    expect(
      GlacisIdentityVerifiedV1.safeParse({
        userId: "not-a-uuid",
        method: "zk_passport",
      }).success,
    ).toBe(false);
  });

  it("rejects empty object", () => {
    expect(GlacisIdentityVerifiedV1.safeParse({}).success).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      GlacisIdentityVerifiedV1.safeParse({
        userId: UUID,
        method: "zk_passport",
        extra: true,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// IncidentDetectedV1
// ---------------------------------------------------------------------------
describe("IncidentDetectedV1", () => {
  it("accepts valid payload", () => {
    expect(
      IncidentDetectedV1.safeParse({
        source: "starknet-mcp",
        severity: "high",
        summary: "RPC node lagging 100+ blocks",
      }).success,
    ).toBe(true);
  });

  it("accepts all severity values", () => {
    for (const severity of ["low", "medium", "high", "critical"] as const) {
      expect(
        IncidentDetectedV1.safeParse({
          source: "x",
          severity,
          summary: "s",
        }).success,
      ).toBe(true);
    }
  });

  it("rejects invalid severity", () => {
    expect(
      IncidentDetectedV1.safeParse({
        source: "x",
        severity: "catastrophic",
        summary: "s",
      }).success,
    ).toBe(false);
  });

  it("rejects empty object", () => {
    expect(IncidentDetectedV1.safeParse({}).success).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      IncidentDetectedV1.safeParse({
        source: "x",
        severity: "low",
        summary: "s",
        extra: true,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// IncidentSloBurnV1
// ---------------------------------------------------------------------------
describe("IncidentSloBurnV1", () => {
  it("accepts valid payload", () => {
    expect(
      IncidentSloBurnV1.safeParse({
        slo: "api_availability_99_9",
        burnRate: 3.5,
        severity: "critical",
      }).success,
    ).toBe(true);
  });

  it("accepts all severity values", () => {
    for (const severity of ["low", "medium", "high", "critical"] as const) {
      expect(IncidentSloBurnV1.safeParse({ slo: "x", burnRate: 1, severity }).success).toBe(true);
    }
  });

  it("rejects missing burnRate", () => {
    expect(IncidentSloBurnV1.safeParse({ slo: "x", severity: "low" }).success).toBe(false);
  });

  it("rejects empty object", () => {
    expect(IncidentSloBurnV1.safeParse({}).success).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      IncidentSloBurnV1.safeParse({
        slo: "x",
        burnRate: 1,
        severity: "low",
        extra: true,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TenantBudgetExceededV1
// ---------------------------------------------------------------------------
describe("TenantBudgetExceededV1", () => {
  it("accepts valid payload", () => {
    expect(
      TenantBudgetExceededV1.safeParse({
        tenantId: UUID,
        period: "2026-01",
        amountUsd: 250,
        limitUsd: 200,
      }).success,
    ).toBe(true);
  });

  it("rejects non-uuid tenantId", () => {
    expect(
      TenantBudgetExceededV1.safeParse({
        tenantId: "bad",
        period: "2026-01",
        amountUsd: 1,
        limitUsd: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects empty object", () => {
    expect(TenantBudgetExceededV1.safeParse({}).success).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      TenantBudgetExceededV1.safeParse({
        tenantId: UUID,
        period: "2026-01",
        amountUsd: 1,
        limitUsd: 1,
        extra: true,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TenantProvisionedV1
// ---------------------------------------------------------------------------
describe("TenantProvisionedV1", () => {
  it("accepts valid payload", () => {
    expect(
      TenantProvisionedV1.safeParse({
        tenantId: UUID,
        plan: "pro",
        virtualKey: "vk_abc123",
      }).success,
    ).toBe(true);
  });

  it("accepts all plan values", () => {
    for (const plan of ["starter", "team", "pro", "enterprise"] as const) {
      expect(
        TenantProvisionedV1.safeParse({
          tenantId: UUID,
          plan,
          virtualKey: "vk",
        }).success,
      ).toBe(true);
    }
  });

  it("rejects invalid plan", () => {
    expect(
      TenantProvisionedV1.safeParse({
        tenantId: UUID,
        plan: "free",
        virtualKey: "vk",
      }).success,
    ).toBe(false);
  });

  it("rejects empty object", () => {
    expect(TenantProvisionedV1.safeParse({}).success).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      TenantProvisionedV1.safeParse({
        tenantId: UUID,
        plan: "pro",
        virtualKey: "vk",
        extra: true,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VaubanFinanceForecastGeneratedV1
// ---------------------------------------------------------------------------
describe("VaubanFinanceForecastGeneratedV1", () => {
  it("accepts valid payload", () => {
    expect(
      VaubanFinanceForecastGeneratedV1.safeParse({
        scenarioId: "nq-bull-2026",
        successRate: 0.72,
        paramVelocity: 1.5,
        timestamp: TS,
        schemaVersion: "1.0.0",
      }).success,
    ).toBe(true);
  });

  it("accepts successRate at boundaries 0 and 1", () => {
    expect(
      VaubanFinanceForecastGeneratedV1.safeParse({
        scenarioId: "x",
        successRate: 0,
        paramVelocity: 0,
        timestamp: TS,
        schemaVersion: "1",
      }).success,
    ).toBe(true);
    expect(
      VaubanFinanceForecastGeneratedV1.safeParse({
        scenarioId: "x",
        successRate: 1,
        paramVelocity: 0,
        timestamp: TS,
        schemaVersion: "1",
      }).success,
    ).toBe(true);
  });

  it("rejects successRate above 1", () => {
    expect(
      VaubanFinanceForecastGeneratedV1.safeParse({
        scenarioId: "x",
        successRate: 1.01,
        paramVelocity: 0,
        timestamp: TS,
        schemaVersion: "1",
      }).success,
    ).toBe(false);
  });

  it("rejects empty object", () => {
    expect(VaubanFinanceForecastGeneratedV1.safeParse({}).success).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      VaubanFinanceForecastGeneratedV1.safeParse({
        scenarioId: "x",
        successRate: 0.5,
        paramVelocity: 1,
        timestamp: TS,
        schemaVersion: "1",
        extra: true,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VaubanFinanceTradeExecutedV1
// ---------------------------------------------------------------------------
describe("VaubanFinanceTradeExecutedV1", () => {
  it("accepts valid payload", () => {
    expect(
      VaubanFinanceTradeExecutedV1.safeParse({
        symbol: "NQ",
        direction: "long",
        quantity: 1,
        conviction: 0.8,
        timestamp: TS,
        schemaVersion: "1.0.0",
      }).success,
    ).toBe(true);
  });

  it("accepts all direction values", () => {
    for (const direction of ["long", "short", "hold"] as const) {
      expect(
        VaubanFinanceTradeExecutedV1.safeParse({
          symbol: "NQ",
          direction,
          quantity: 1,
          conviction: 0.5,
          timestamp: TS,
          schemaVersion: "1",
        }).success,
      ).toBe(true);
    }
  });

  it("rejects invalid direction", () => {
    expect(
      VaubanFinanceTradeExecutedV1.safeParse({
        symbol: "NQ",
        direction: "buy",
        quantity: 1,
        conviction: 0.5,
        timestamp: TS,
        schemaVersion: "1",
      }).success,
    ).toBe(false);
  });

  it("rejects conviction above 1", () => {
    expect(
      VaubanFinanceTradeExecutedV1.safeParse({
        symbol: "NQ",
        direction: "long",
        quantity: 1,
        conviction: 1.5,
        timestamp: TS,
        schemaVersion: "1",
      }).success,
    ).toBe(false);
  });

  it("rejects empty object", () => {
    expect(VaubanFinanceTradeExecutedV1.safeParse({}).success).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      VaubanFinanceTradeExecutedV1.safeParse({
        symbol: "NQ",
        direction: "long",
        quantity: 1,
        conviction: 0.5,
        timestamp: TS,
        schemaVersion: "1",
        extra: true,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VaubanGoalCheckedV1
// ---------------------------------------------------------------------------
describe("VaubanGoalCheckedV1", () => {
  it("accepts valid payload", () => {
    expect(
      VaubanGoalCheckedV1.safeParse({
        goalId: "goal-retirement-2050",
        successRate: 0.88,
        alertLevel: "none",
        timestamp: TS,
        schemaVersion: "1.0.0",
      }).success,
    ).toBe(true);
  });

  it("accepts all alertLevel values", () => {
    for (const alertLevel of ["none", "warning", "critical"] as const) {
      expect(
        VaubanGoalCheckedV1.safeParse({
          goalId: "g",
          successRate: 0.5,
          alertLevel,
          timestamp: TS,
          schemaVersion: "1",
        }).success,
      ).toBe(true);
    }
  });

  it("rejects invalid alertLevel", () => {
    expect(
      VaubanGoalCheckedV1.safeParse({
        goalId: "g",
        successRate: 0.5,
        alertLevel: "severe",
        timestamp: TS,
        schemaVersion: "1",
      }).success,
    ).toBe(false);
  });

  it("rejects empty object", () => {
    expect(VaubanGoalCheckedV1.safeParse({}).success).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      VaubanGoalCheckedV1.safeParse({
        goalId: "g",
        successRate: 0.5,
        alertLevel: "none",
        timestamp: TS,
        schemaVersion: "1",
        extra: true,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VaubanRebalancingCheckedV1
// ---------------------------------------------------------------------------
describe("VaubanRebalancingCheckedV1", () => {
  it("accepts valid payload", () => {
    expect(
      VaubanRebalancingCheckedV1.safeParse({
        portfolioId: "portfolio-main",
        maxDrift: 0.05,
        alertLevel: "warning",
        timestamp: TS,
        schemaVersion: "1.0.0",
      }).success,
    ).toBe(true);
  });

  it("accepts all alertLevel values", () => {
    for (const alertLevel of ["none", "warning", "critical"] as const) {
      expect(
        VaubanRebalancingCheckedV1.safeParse({
          portfolioId: "p",
          maxDrift: 0,
          alertLevel,
          timestamp: TS,
          schemaVersion: "1",
        }).success,
      ).toBe(true);
    }
  });

  it("rejects missing portfolioId", () => {
    expect(
      VaubanRebalancingCheckedV1.safeParse({
        maxDrift: 0,
        alertLevel: "none",
        timestamp: TS,
        schemaVersion: "1",
      }).success,
    ).toBe(false);
  });

  it("rejects empty object", () => {
    expect(VaubanRebalancingCheckedV1.safeParse({}).success).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      VaubanRebalancingCheckedV1.safeParse({
        portfolioId: "p",
        maxDrift: 0,
        alertLevel: "none",
        timestamp: TS,
        schemaVersion: "1",
        extra: true,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VaubanTaxCheckedV1
// ---------------------------------------------------------------------------
describe("VaubanTaxCheckedV1", () => {
  it("accepts valid payload with rules", () => {
    expect(
      VaubanTaxCheckedV1.safeParse({
        userId: "user-123",
        rulesTriggered: ["PFU_30", "IFI_check"],
        alertLevel: "warning",
        timestamp: TS,
        schemaVersion: "1.0.0",
      }).success,
    ).toBe(true);
  });

  it("accepts empty rulesTriggered", () => {
    expect(
      VaubanTaxCheckedV1.safeParse({
        userId: "u",
        rulesTriggered: [],
        alertLevel: "none",
        timestamp: TS,
        schemaVersion: "1",
      }).success,
    ).toBe(true);
  });

  it("rejects missing userId", () => {
    expect(
      VaubanTaxCheckedV1.safeParse({
        rulesTriggered: [],
        alertLevel: "none",
        timestamp: TS,
        schemaVersion: "1",
      }).success,
    ).toBe(false);
  });

  it("rejects empty object", () => {
    expect(VaubanTaxCheckedV1.safeParse({}).success).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      VaubanTaxCheckedV1.safeParse({
        userId: "u",
        rulesTriggered: [],
        alertLevel: "none",
        timestamp: TS,
        schemaVersion: "1",
        extra: true,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VaubanVaultAnalyzedV1
// ---------------------------------------------------------------------------
describe("VaubanVaultAnalyzedV1", () => {
  const validAnomaly = {
    type: "tvl_drop",
    severity: "warning" as const,
    metric: "tvl",
    current: 950000,
    expected: 1000000,
    description: "TVL dropped 5%",
  };

  it("accepts valid payload with anomalies", () => {
    expect(
      VaubanVaultAnalyzedV1.safeParse({
        vaultId: "vault-alpha",
        tvlUsd: 1000000,
        anomalies: [validAnomaly],
        overallSeverity: "warning",
        timestamp: TS,
        schemaVersion: "1.0.0",
      }).success,
    ).toBe(true);
  });

  it("accepts anomaly with string current/expected", () => {
    expect(
      VaubanVaultAnalyzedV1.safeParse({
        vaultId: "v",
        tvlUsd: 0,
        anomalies: [{ ...validAnomaly, current: "high", expected: "low" }],
        overallSeverity: "info",
        timestamp: TS,
        schemaVersion: "1",
      }).success,
    ).toBe(true);
  });

  it("accepts empty anomalies array", () => {
    expect(
      VaubanVaultAnalyzedV1.safeParse({
        vaultId: "v",
        tvlUsd: 1000,
        anomalies: [],
        overallSeverity: "info",
        timestamp: TS,
        schemaVersion: "1",
      }).success,
    ).toBe(true);
  });

  it("rejects invalid anomaly severity", () => {
    expect(
      VaubanVaultAnalyzedV1.safeParse({
        vaultId: "v",
        tvlUsd: 0,
        anomalies: [{ ...validAnomaly, severity: "fatal" }],
        overallSeverity: "info",
        timestamp: TS,
        schemaVersion: "1",
      }).success,
    ).toBe(false);
  });

  it("rejects empty object", () => {
    expect(VaubanVaultAnalyzedV1.safeParse({}).success).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      VaubanVaultAnalyzedV1.safeParse({
        vaultId: "v",
        tvlUsd: 0,
        anomalies: [],
        overallSeverity: "info",
        timestamp: TS,
        schemaVersion: "1",
        extra: true,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VaubanVaultCompoundedV1
// ---------------------------------------------------------------------------
describe("VaubanVaultCompoundedV1", () => {
  it("accepts minimal valid payload", () => {
    expect(
      VaubanVaultCompoundedV1.safeParse({
        vaultId: "vault-beta",
        compoundedAt: TS,
        rewardsUsd: 150.5,
        caller: "0x04330c3b",
        schemaVersion: "1.0.0",
      }).success,
    ).toBe(true);
  });

  it("accepts optional txHash", () => {
    expect(
      VaubanVaultCompoundedV1.safeParse({
        vaultId: "v",
        compoundedAt: TS,
        rewardsUsd: 0,
        caller: "0xabc",
        txHash: "0xdeadbeef",
        schemaVersion: "1",
      }).success,
    ).toBe(true);
  });

  it("rejects missing caller", () => {
    expect(
      VaubanVaultCompoundedV1.safeParse({
        vaultId: "v",
        compoundedAt: TS,
        rewardsUsd: 0,
        schemaVersion: "1",
      }).success,
    ).toBe(false);
  });

  it("rejects empty object", () => {
    expect(VaubanVaultCompoundedV1.safeParse({}).success).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      VaubanVaultCompoundedV1.safeParse({
        vaultId: "v",
        compoundedAt: TS,
        rewardsUsd: 0,
        caller: "0x",
        schemaVersion: "1",
        extra: true,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VaubanVaultRebalancedV1
// ---------------------------------------------------------------------------
describe("VaubanVaultRebalancedV1", () => {
  it("accepts valid payload", () => {
    expect(
      VaubanVaultRebalancedV1.safeParse({
        vaultId: "vault-main",
        txHash: "0xabcdef1234567890",
      }).success,
    ).toBe(true);
  });

  it("rejects missing txHash", () => {
    expect(VaubanVaultRebalancedV1.safeParse({ vaultId: "v" }).success).toBe(false);
  });

  it("rejects empty object", () => {
    expect(VaubanVaultRebalancedV1.safeParse({}).success).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      VaubanVaultRebalancedV1.safeParse({
        vaultId: "v",
        txHash: "0x",
        extra: true,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VaubanVaultRebalanceProposedV1
// ---------------------------------------------------------------------------
describe("VaubanVaultRebalanceProposedV1", () => {
  it("accepts valid payload", () => {
    expect(
      VaubanVaultRebalanceProposedV1.safeParse({
        vaultId: "vault-main",
        currentRatio: 0.6,
        targetRatio: 0.5,
      }).success,
    ).toBe(true);
  });

  it("rejects missing vaultId", () => {
    expect(
      VaubanVaultRebalanceProposedV1.safeParse({
        currentRatio: 0.6,
        targetRatio: 0.5,
      }).success,
    ).toBe(false);
  });

  it("rejects empty object", () => {
    expect(VaubanVaultRebalanceProposedV1.safeParse({}).success).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      VaubanVaultRebalanceProposedV1.safeParse({
        vaultId: "v",
        currentRatio: 0.5,
        targetRatio: 0.5,
        extra: true,
      }).success,
    ).toBe(false);
  });
});
