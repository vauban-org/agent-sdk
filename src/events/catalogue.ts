import type { z } from "zod";
import { AgentCompletedV1 } from "./schemas/agent.completed.v1.js";
import { AgentFailedV1 } from "./schemas/agent.failed.v1.js";
import { AgentHitlRequestedV1 } from "./schemas/agent.hitl_requested.v1.js";
import { AgentHitlResolvedV1 } from "./schemas/agent.hitl_resolved.v1.js";
import { AgentStartedV1 } from "./schemas/agent.started.v1.js";
import { BrainSkillExtractedV1 } from "./schemas/brain.skill.extracted.v1.js";
import { CcCostAnomalyDetectedV1 } from "./schemas/cc.cost.anomaly_detected.v1.js";
import { CcCostRecordedV1 } from "./schemas/cc.cost.recorded.v1.js";
import { CitadelSprintAnalyzedV1 } from "./schemas/citadel.sprint.analyzed.v1.js";
import { CitadelSprintClosedV1 } from "./schemas/citadel.sprint.closed.v1.js";
import { ForgeInboxReplyClassifiedV1 } from "./schemas/forge.inbox.reply_classified.v1.js";
import { ForgeLeadQualifiedV1 } from "./schemas/forge.lead.qualified.v1.js";
import { ForgeOutreachSentV1 } from "./schemas/forge.outreach.sent.v1.js";
import { ForgePolicyTriggeredV1 } from "./schemas/forge.policy.triggered.v1.js";
import { GlacisIdentityVerifiedV1 } from "./schemas/glacis.identity.verified.v1.js";
import { IncidentDetectedV1 } from "./schemas/incident.detected.v1.js";
import { IncidentSloBurnV1 } from "./schemas/incident.slo_burn.v1.js";
import { TenantBudgetExceededV1 } from "./schemas/tenant.budget.exceeded.v1.js";
import { TenantProvisionedV1 } from "./schemas/tenant.provisioned.v1.js";
import { VaubanFinanceForecastGeneratedV1 } from "./schemas/vauban-finance.forecast.generated.v1.js";
import { VaubanFinanceTradeExecutedV1 } from "./schemas/vauban-finance.trade.executed.v1.js";
import { VaubanGoalCheckedV1 } from "./schemas/vauban.goal.checked.v1.js";
import { VaubanRebalancingCheckedV1 } from "./schemas/vauban.rebalancing.checked.v1.js";
import { VaubanTaxCheckedV1 } from "./schemas/vauban.tax.checked.v1.js";
import { VaubanVaultAnalyzedV1 } from "./schemas/vauban.vault.analyzed.v1.js";
import { VaubanVaultCompoundedV1 } from "./schemas/vauban.vault.compounded.v1.js";
import { VaubanVaultRebalanceProposedV1 } from "./schemas/vauban.vault.rebalance_proposed.v1.js";
import { VaubanVaultRebalancedV1 } from "./schemas/vauban.vault.rebalanced.v1.js";

/** @public */
export const EventSchemas = {
  "agent.started": AgentStartedV1,
  "agent.completed": AgentCompletedV1,
  "agent.failed": AgentFailedV1,
  "agent.hitl_requested": AgentHitlRequestedV1,
  "agent.hitl_resolved": AgentHitlResolvedV1,
  "incident.slo_burn": IncidentSloBurnV1,
  "incident.detected": IncidentDetectedV1,
  "forge.inbox.reply_classified": ForgeInboxReplyClassifiedV1,
  "forge.lead.qualified": ForgeLeadQualifiedV1,
  "forge.outreach.sent": ForgeOutreachSentV1,
  "forge.policy.triggered": ForgePolicyTriggeredV1,
  "vauban.vault.rebalance_proposed": VaubanVaultRebalanceProposedV1,
  "vauban.vault.rebalanced": VaubanVaultRebalancedV1,
  "vauban.vault.analyzed": VaubanVaultAnalyzedV1,
  "vauban.goal.checked": VaubanGoalCheckedV1,
  "vauban.rebalancing.checked": VaubanRebalancingCheckedV1,
  "vauban.tax.checked": VaubanTaxCheckedV1,
  "vauban.vault.compounded": VaubanVaultCompoundedV1,
  "vauban-finance.forecast.generated": VaubanFinanceForecastGeneratedV1,
  "vauban-finance.trade.executed": VaubanFinanceTradeExecutedV1,
  "glacis.identity.verified": GlacisIdentityVerifiedV1,
  "citadel.sprint.closed": CitadelSprintClosedV1,
  "citadel.sprint.analyzed": CitadelSprintAnalyzedV1,
  "brain.skill.extracted": BrainSkillExtractedV1,
  "cc.cost.recorded": CcCostRecordedV1,
  "cc.cost.anomaly_detected": CcCostAnomalyDetectedV1,
  "tenant.provisioned": TenantProvisionedV1,
  "tenant.budget.exceeded": TenantBudgetExceededV1,
} as const;

/** @public */
export type EventType =
  | { type: "agent.started"; payload: z.infer<typeof AgentStartedV1> }
  | { type: "agent.completed"; payload: z.infer<typeof AgentCompletedV1> }
  | { type: "agent.failed"; payload: z.infer<typeof AgentFailedV1> }
  | {
      type: "agent.hitl_requested";
      payload: z.infer<typeof AgentHitlRequestedV1>;
    }
  | {
      type: "agent.hitl_resolved";
      payload: z.infer<typeof AgentHitlResolvedV1>;
    }
  | { type: "incident.slo_burn"; payload: z.infer<typeof IncidentSloBurnV1> }
  | { type: "incident.detected"; payload: z.infer<typeof IncidentDetectedV1> }
  | {
      type: "forge.inbox.reply_classified";
      payload: z.infer<typeof ForgeInboxReplyClassifiedV1>;
    }
  | {
      type: "forge.lead.qualified";
      payload: z.infer<typeof ForgeLeadQualifiedV1>;
    }
  | {
      type: "forge.outreach.sent";
      payload: z.infer<typeof ForgeOutreachSentV1>;
    }
  | {
      type: "forge.policy.triggered";
      payload: z.infer<typeof ForgePolicyTriggeredV1>;
    }
  | {
      type: "vauban.vault.rebalance_proposed";
      payload: z.infer<typeof VaubanVaultRebalanceProposedV1>;
    }
  | {
      type: "vauban.vault.rebalanced";
      payload: z.infer<typeof VaubanVaultRebalancedV1>;
    }
  | {
      type: "glacis.identity.verified";
      payload: z.infer<typeof GlacisIdentityVerifiedV1>;
    }
  | {
      type: "citadel.sprint.closed";
      payload: z.infer<typeof CitadelSprintClosedV1>;
    }
  | {
      type: "citadel.sprint.analyzed";
      payload: z.infer<typeof CitadelSprintAnalyzedV1>;
    }
  | {
      type: "brain.skill.extracted";
      payload: z.infer<typeof BrainSkillExtractedV1>;
    }
  | { type: "cc.cost.recorded"; payload: z.infer<typeof CcCostRecordedV1> }
  | {
      type: "cc.cost.anomaly_detected";
      payload: z.infer<typeof CcCostAnomalyDetectedV1>;
    }
  | { type: "tenant.provisioned"; payload: z.infer<typeof TenantProvisionedV1> }
  | {
      type: "tenant.budget.exceeded";
      payload: z.infer<typeof TenantBudgetExceededV1>;
    }
  | {
      type: "vauban.vault.analyzed";
      payload: z.infer<typeof VaubanVaultAnalyzedV1>;
    }
  | {
      type: "vauban.goal.checked";
      payload: z.infer<typeof VaubanGoalCheckedV1>;
    }
  | {
      type: "vauban.rebalancing.checked";
      payload: z.infer<typeof VaubanRebalancingCheckedV1>;
    }
  | {
      type: "vauban.tax.checked";
      payload: z.infer<typeof VaubanTaxCheckedV1>;
    }
  | {
      type: "vauban.vault.compounded";
      payload: z.infer<typeof VaubanVaultCompoundedV1>;
    }
  | {
      type: "vauban-finance.forecast.generated";
      payload: z.infer<typeof VaubanFinanceForecastGeneratedV1>;
    }
  | {
      type: "vauban-finance.trade.executed";
      payload: z.infer<typeof VaubanFinanceTradeExecutedV1>;
    };

/** @public */
export type EventTypeName = keyof typeof EventSchemas;

/** @public */
export function resolveSchema(type: string): z.ZodObject<z.ZodRawShape> | undefined {
  return (EventSchemas as Record<string, z.ZodObject<z.ZodRawShape>>)[type];
}

/** @public */
export function validateEvent(type: string, payload: unknown): { valid: boolean; error?: string } {
  const schema = resolveSchema(type);
  if (!schema) {
    return { valid: false, error: `Unknown event type: ${type}` };
  }
  const result = schema.safeParse(payload);
  if (result.success) return { valid: true };
  return { valid: false, error: result.error.message };
}
