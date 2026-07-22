// @ts-nocheck
/**
 * Document Intelligence v3 â€” Feature Flag (Phase 1, inert)
 *
 * Mirrors the Deno.env.get(...) boolean-flag convention already used by
 * NORMALIZE_INLINE_ENRICHMENT and EXTRACTION_PROVIDER. Nothing in the
 * runtime pipeline reads ENABLE_DOCUMENT_INTELLIGENCE_V3 yet â€” Phase 1 is
 * scaffold-only (contract types + a read-only compatibility adapter + a
 * durable-storage migration, none of them wired into parse-document-azure,
 * normalize-pdf-output, or LeaseReview.jsx). This flag exists so a later
 * phase has one canonical, already-tested place to gate v3 behavior instead
 * of inventing the check ad hoc when that phase starts.
 *
 * Default is false (current behavior) whenever the env var is unset or is
 * anything other than an explicit truthy value.
 */

const FLAG_NAME = "ENABLE_DOCUMENT_INTELLIGENCE_V3";

const TRUTHY_VALUES = new Set(["true", "1", "on", "yes"]);

export interface EnvLike {
  get(key: string): string | undefined;
}

export function isDocumentIntelligenceV3Enabled(env: EnvLike = Deno.env): boolean {
  const raw = String(env.get(FLAG_NAME) ?? "").trim().toLowerCase();
  return TRUTHY_VALUES.has(raw);
}

export const DOCUMENT_INTELLIGENCE_V3_FLAG_NAME = FLAG_NAME;
const PARSE_QUALITY_APPROVAL_BLOCKING_FLAG_NAME = "ENABLE_PARSE_QUALITY_APPROVAL_BLOCKING";

export function isParseQualityApprovalBlockingEnabled(env: EnvLike = Deno.env): boolean {
  const raw = String(env.get(PARSE_QUALITY_APPROVAL_BLOCKING_FLAG_NAME) ?? "").trim().toLowerCase();
  return TRUTHY_VALUES.has(raw);
}

export const PARSE_QUALITY_APPROVAL_BLOCKING_ENV_NAME = PARSE_QUALITY_APPROVAL_BLOCKING_FLAG_NAME;

const CANONICAL_REVIEW_PAYLOAD_FLAG_NAME = "ENABLE_CANONICAL_REVIEW_PAYLOAD";
const CANONICAL_REVIEW_PAYLOAD_STRICT_FLAG_NAME = "ENABLE_CANONICAL_REVIEW_PAYLOAD_STRICT";

export function isCanonicalReviewPayloadEnabled(env: EnvLike = Deno.env): boolean {
  const raw = String(env.get(CANONICAL_REVIEW_PAYLOAD_FLAG_NAME) ?? "").trim().toLowerCase();
  return TRUTHY_VALUES.has(raw);
}

export function isCanonicalReviewPayloadStrictEnabled(env: EnvLike = Deno.env): boolean {
  const raw = String(env.get(CANONICAL_REVIEW_PAYLOAD_STRICT_FLAG_NAME) ?? "").trim().toLowerCase();
  return TRUTHY_VALUES.has(raw);
}

export const CANONICAL_REVIEW_PAYLOAD_ENV_NAME = CANONICAL_REVIEW_PAYLOAD_FLAG_NAME;
export const CANONICAL_REVIEW_PAYLOAD_STRICT_ENV_NAME = CANONICAL_REVIEW_PAYLOAD_STRICT_FLAG_NAME;
const CANONICAL_APPROVAL_GATING_FLAG_NAME = "ENABLE_CANONICAL_APPROVAL_GATING";
const CANONICAL_HYBRID_EMERGENCY_FALLBACK_FLAG_NAME = "ENABLE_CANONICAL_HYBRID_EMERGENCY_FALLBACK";

export function isCanonicalApprovalGatingEnabled(env: EnvLike = Deno.env): boolean {
  const raw = String(env.get(CANONICAL_APPROVAL_GATING_FLAG_NAME) ?? "").trim().toLowerCase();
  return TRUTHY_VALUES.has(raw);
}

export function isCanonicalHybridEmergencyFallbackEnabled(env: EnvLike = Deno.env): boolean {
  const raw = String(env.get(CANONICAL_HYBRID_EMERGENCY_FALLBACK_FLAG_NAME) ?? "").trim().toLowerCase();
  return TRUTHY_VALUES.has(raw);
}

export const CANONICAL_APPROVAL_GATING_ENV_NAME = CANONICAL_APPROVAL_GATING_FLAG_NAME;
export const CANONICAL_HYBRID_EMERGENCY_FALLBACK_ENV_NAME = CANONICAL_HYBRID_EMERGENCY_FALLBACK_FLAG_NAME;
const DOCUMENT_SEMANTICS_V6_FLAG_NAME = "ENABLE_DOCUMENT_SEMANTICS_V6";
const DEFINITION_RESOLUTION_V6_FLAG_NAME = "ENABLE_DEFINITION_RESOLUTION_V6";
const CROSS_REFERENCE_RESOLUTION_V6_FLAG_NAME = "ENABLE_CROSS_REFERENCE_RESOLUTION_V6";
const AMENDMENT_PRECEDENCE_V6_FLAG_NAME = "ENABLE_AMENDMENT_PRECEDENCE_V6";
const SEMANTIC_FIELD_SEARCH_V6_FLAG_NAME = "ENABLE_SEMANTIC_FIELD_SEARCH_V6";
const ENTERPRISE_REVIEW_PAYLOAD_V2_FLAG_NAME = "ENABLE_ENTERPRISE_REVIEW_PAYLOAD_V2";
const SEMANTIC_APPROVAL_GATING_FLAG_NAME = "ENABLE_SEMANTIC_APPROVAL_GATING";

function readTruthyFlag(env: EnvLike, name: string): boolean {
  const raw = String(env.get(name) ?? "").trim().toLowerCase();
  return TRUTHY_VALUES.has(raw);
}

export function isDocumentSemanticsV6Enabled(env: EnvLike = Deno.env): boolean {
  return readTruthyFlag(env, DOCUMENT_SEMANTICS_V6_FLAG_NAME);
}

export function isDefinitionResolutionV6Enabled(env: EnvLike = Deno.env): boolean {
  return readTruthyFlag(env, DEFINITION_RESOLUTION_V6_FLAG_NAME);
}

export function isCrossReferenceResolutionV6Enabled(env: EnvLike = Deno.env): boolean {
  return readTruthyFlag(env, CROSS_REFERENCE_RESOLUTION_V6_FLAG_NAME);
}

export function isAmendmentPrecedenceV6Enabled(env: EnvLike = Deno.env): boolean {
  return readTruthyFlag(env, AMENDMENT_PRECEDENCE_V6_FLAG_NAME);
}

export function isSemanticFieldSearchV6Enabled(env: EnvLike = Deno.env): boolean {
  return readTruthyFlag(env, SEMANTIC_FIELD_SEARCH_V6_FLAG_NAME);
}

export function isEnterpriseReviewPayloadV2Enabled(env: EnvLike = Deno.env): boolean {
  return readTruthyFlag(env, ENTERPRISE_REVIEW_PAYLOAD_V2_FLAG_NAME);
}

export function isSemanticApprovalGatingEnabled(env: EnvLike = Deno.env): boolean {
  return readTruthyFlag(env, SEMANTIC_APPROVAL_GATING_FLAG_NAME);
}

export const DOCUMENT_SEMANTICS_V6_ENV_NAME = DOCUMENT_SEMANTICS_V6_FLAG_NAME;
export const DEFINITION_RESOLUTION_V6_ENV_NAME = DEFINITION_RESOLUTION_V6_FLAG_NAME;
export const CROSS_REFERENCE_RESOLUTION_V6_ENV_NAME = CROSS_REFERENCE_RESOLUTION_V6_FLAG_NAME;
export const AMENDMENT_PRECEDENCE_V6_ENV_NAME = AMENDMENT_PRECEDENCE_V6_FLAG_NAME;
export const SEMANTIC_FIELD_SEARCH_V6_ENV_NAME = SEMANTIC_FIELD_SEARCH_V6_FLAG_NAME;
export const ENTERPRISE_REVIEW_PAYLOAD_V2_ENV_NAME = ENTERPRISE_REVIEW_PAYLOAD_V2_FLAG_NAME;
export const SEMANTIC_APPROVAL_GATING_ENV_NAME = SEMANTIC_APPROVAL_GATING_FLAG_NAME;
const PORTFOLIO_INTELLIGENCE_V8_FLAG_NAME = "ENABLE_PORTFOLIO_INTELLIGENCE_V8";
const PORTFOLIO_FACT_MATERIALIZATION_FLAG_NAME = "ENABLE_PORTFOLIO_FACT_MATERIALIZATION";
const PORTFOLIO_CRITICAL_DATES_FLAG_NAME = "ENABLE_PORTFOLIO_CRITICAL_DATES";
const PORTFOLIO_SEMANTIC_SEARCH_FLAG_NAME = "ENABLE_PORTFOLIO_SEMANTIC_SEARCH";
const PORTFOLIO_RISK_SCORING_FLAG_NAME = "ENABLE_PORTFOLIO_RISK_SCORING";
const RENT_ROLL_RECONCILIATION_FLAG_NAME = "ENABLE_RENT_ROLL_RECONCILIATION";
const PORTFOLIO_EXPORTS_FLAG_NAME = "ENABLE_PORTFOLIO_EXPORTS";
const PORTFOLIO_INTEGRATION_API_FLAG_NAME = "ENABLE_PORTFOLIO_INTEGRATION_API";

export function isPortfolioIntelligenceV8Enabled(env: EnvLike = Deno.env): boolean {
  return readTruthyFlag(env, PORTFOLIO_INTELLIGENCE_V8_FLAG_NAME);
}

export function isPortfolioFactMaterializationEnabled(env: EnvLike = Deno.env): boolean {
  return readTruthyFlag(env, PORTFOLIO_FACT_MATERIALIZATION_FLAG_NAME);
}

export function isPortfolioCriticalDatesEnabled(env: EnvLike = Deno.env): boolean {
  return readTruthyFlag(env, PORTFOLIO_CRITICAL_DATES_FLAG_NAME);
}

export function isPortfolioSemanticSearchEnabled(env: EnvLike = Deno.env): boolean {
  return readTruthyFlag(env, PORTFOLIO_SEMANTIC_SEARCH_FLAG_NAME);
}

export function isPortfolioRiskScoringEnabled(env: EnvLike = Deno.env): boolean {
  return readTruthyFlag(env, PORTFOLIO_RISK_SCORING_FLAG_NAME);
}

export function isRentRollReconciliationEnabled(env: EnvLike = Deno.env): boolean {
  return readTruthyFlag(env, RENT_ROLL_RECONCILIATION_FLAG_NAME);
}

export function isPortfolioExportsEnabled(env: EnvLike = Deno.env): boolean {
  return readTruthyFlag(env, PORTFOLIO_EXPORTS_FLAG_NAME);
}

export function isPortfolioIntegrationApiEnabled(env: EnvLike = Deno.env): boolean {
  return readTruthyFlag(env, PORTFOLIO_INTEGRATION_API_FLAG_NAME);
}

export const PORTFOLIO_INTELLIGENCE_V8_ENV_NAME = PORTFOLIO_INTELLIGENCE_V8_FLAG_NAME;
export const PORTFOLIO_FACT_MATERIALIZATION_ENV_NAME = PORTFOLIO_FACT_MATERIALIZATION_FLAG_NAME;
export const PORTFOLIO_CRITICAL_DATES_ENV_NAME = PORTFOLIO_CRITICAL_DATES_FLAG_NAME;
export const PORTFOLIO_SEMANTIC_SEARCH_ENV_NAME = PORTFOLIO_SEMANTIC_SEARCH_FLAG_NAME;
export const PORTFOLIO_RISK_SCORING_ENV_NAME = PORTFOLIO_RISK_SCORING_FLAG_NAME;
export const RENT_ROLL_RECONCILIATION_ENV_NAME = RENT_ROLL_RECONCILIATION_FLAG_NAME;
export const PORTFOLIO_EXPORTS_ENV_NAME = PORTFOLIO_EXPORTS_FLAG_NAME;
export const PORTFOLIO_INTEGRATION_API_ENV_NAME = PORTFOLIO_INTEGRATION_API_FLAG_NAME;

const EVENT_BUS_FLAG_NAME = "ENABLE_EVENT_BUS";
const WORKFLOW_ENGINE_FLAG_NAME = "ENABLE_WORKFLOW_ENGINE";
const WEBHOOKS_FLAG_NAME = "ENABLE_WEBHOOKS";
const NOTIFICATIONS_FLAG_NAME = "ENABLE_NOTIFICATIONS";
const CONNECTORS_FLAG_NAME = "ENABLE_CONNECTORS";
const PUBLIC_API_FLAG_NAME = "ENABLE_PUBLIC_API";
const EXPORT_AUTOMATION_FLAG_NAME = "ENABLE_EXPORT_AUTOMATION";
const CALENDAR_SYNC_FLAG_NAME = "ENABLE_CALENDAR_SYNC";

export function isEventBusEnabled(env: EnvLike = Deno.env): boolean { return readTruthyFlag(env, EVENT_BUS_FLAG_NAME); }
export function isWorkflowEngineEnabled(env: EnvLike = Deno.env): boolean { return readTruthyFlag(env, WORKFLOW_ENGINE_FLAG_NAME); }
export function isWebhooksEnabled(env: EnvLike = Deno.env): boolean { return readTruthyFlag(env, WEBHOOKS_FLAG_NAME); }
export function isNotificationsEnabled(env: EnvLike = Deno.env): boolean { return readTruthyFlag(env, NOTIFICATIONS_FLAG_NAME); }
export function isConnectorsEnabled(env: EnvLike = Deno.env): boolean { return readTruthyFlag(env, CONNECTORS_FLAG_NAME); }
export function isPublicApiEnabled(env: EnvLike = Deno.env): boolean { return readTruthyFlag(env, PUBLIC_API_FLAG_NAME); }
export function isExportAutomationEnabled(env: EnvLike = Deno.env): boolean { return readTruthyFlag(env, EXPORT_AUTOMATION_FLAG_NAME); }
export function isCalendarSyncEnabled(env: EnvLike = Deno.env): boolean { return readTruthyFlag(env, CALENDAR_SYNC_FLAG_NAME); }

export const EVENT_BUS_ENV_NAME = EVENT_BUS_FLAG_NAME;
export const WORKFLOW_ENGINE_ENV_NAME = WORKFLOW_ENGINE_FLAG_NAME;
export const WEBHOOKS_ENV_NAME = WEBHOOKS_FLAG_NAME;
export const NOTIFICATIONS_ENV_NAME = NOTIFICATIONS_FLAG_NAME;
export const CONNECTORS_ENV_NAME = CONNECTORS_FLAG_NAME;
export const PUBLIC_API_ENV_NAME = PUBLIC_API_FLAG_NAME;
export const EXPORT_AUTOMATION_ENV_NAME = EXPORT_AUTOMATION_FLAG_NAME;
export const CALENDAR_SYNC_ENV_NAME = CALENDAR_SYNC_FLAG_NAME;

const ENTERPRISE_RBAC_V10_FLAG_NAME = "ENABLE_ENTERPRISE_RBAC_V10";
const DELEGATED_ADMIN_FLAG_NAME = "ENABLE_DELEGATED_ADMIN";
const SUPPORT_ACCESS_CONTROL_FLAG_NAME = "ENABLE_SUPPORT_ACCESS_CONTROL";
const COMPLIANCE_EVIDENCE_FLAG_NAME = "ENABLE_COMPLIANCE_EVIDENCE";
const RETENTION_ENFORCEMENT_FLAG_NAME = "ENABLE_RETENTION_ENFORCEMENT";
const RESIDENCY_ENFORCEMENT_FLAG_NAME = "ENABLE_RESIDENCY_ENFORCEMENT";
const ORGANIZATION_QUOTAS_FLAG_NAME = "ENABLE_ORGANIZATION_QUOTAS";
const ERROR_BUDGET_GATES_FLAG_NAME = "ENABLE_ERROR_BUDGET_GATES";
const ASYNC_EXPORTS_FLAG_NAME = "ENABLE_ASYNC_EXPORTS";
const LEGACY_RETIREMENT_CONTROLS_FLAG_NAME = "ENABLE_LEGACY_RETIREMENT_CONTROLS";
const BROAD_GA_FLAG_NAME = "ENABLE_BROAD_GA";

export function isEnterpriseRbacV10Enabled(env: EnvLike = Deno.env): boolean { return readTruthyFlag(env, ENTERPRISE_RBAC_V10_FLAG_NAME); }
export function isDelegatedAdminEnabled(env: EnvLike = Deno.env): boolean { return readTruthyFlag(env, DELEGATED_ADMIN_FLAG_NAME); }
export function isSupportAccessControlEnabled(env: EnvLike = Deno.env): boolean { return readTruthyFlag(env, SUPPORT_ACCESS_CONTROL_FLAG_NAME); }
export function isComplianceEvidenceEnabled(env: EnvLike = Deno.env): boolean { return readTruthyFlag(env, COMPLIANCE_EVIDENCE_FLAG_NAME); }
export function isRetentionEnforcementEnabled(env: EnvLike = Deno.env): boolean { return readTruthyFlag(env, RETENTION_ENFORCEMENT_FLAG_NAME); }
export function isResidencyEnforcementEnabled(env: EnvLike = Deno.env): boolean { return readTruthyFlag(env, RESIDENCY_ENFORCEMENT_FLAG_NAME); }
export function isOrganizationQuotasEnabled(env: EnvLike = Deno.env): boolean { return readTruthyFlag(env, ORGANIZATION_QUOTAS_FLAG_NAME); }
export function isErrorBudgetGatesEnabled(env: EnvLike = Deno.env): boolean { return readTruthyFlag(env, ERROR_BUDGET_GATES_FLAG_NAME); }
export function isAsyncExportsEnabled(env: EnvLike = Deno.env): boolean { return readTruthyFlag(env, ASYNC_EXPORTS_FLAG_NAME); }
export function isLegacyRetirementControlsEnabled(env: EnvLike = Deno.env): boolean { return readTruthyFlag(env, LEGACY_RETIREMENT_CONTROLS_FLAG_NAME); }
export function isBroadGaEnabled(env: EnvLike = Deno.env): boolean { return readTruthyFlag(env, BROAD_GA_FLAG_NAME); }

export const ENTERPRISE_RBAC_V10_ENV_NAME = ENTERPRISE_RBAC_V10_FLAG_NAME;
export const DELEGATED_ADMIN_ENV_NAME = DELEGATED_ADMIN_FLAG_NAME;
export const SUPPORT_ACCESS_CONTROL_ENV_NAME = SUPPORT_ACCESS_CONTROL_FLAG_NAME;
export const COMPLIANCE_EVIDENCE_ENV_NAME = COMPLIANCE_EVIDENCE_FLAG_NAME;
export const RETENTION_ENFORCEMENT_ENV_NAME = RETENTION_ENFORCEMENT_FLAG_NAME;
export const RESIDENCY_ENFORCEMENT_ENV_NAME = RESIDENCY_ENFORCEMENT_FLAG_NAME;
export const ORGANIZATION_QUOTAS_ENV_NAME = ORGANIZATION_QUOTAS_FLAG_NAME;
export const ERROR_BUDGET_GATES_ENV_NAME = ERROR_BUDGET_GATES_FLAG_NAME;
export const ASYNC_EXPORTS_ENV_NAME = ASYNC_EXPORTS_FLAG_NAME;
export const LEGACY_RETIREMENT_CONTROLS_ENV_NAME = LEGACY_RETIREMENT_CONTROLS_FLAG_NAME;
export const BROAD_GA_ENV_NAME = BROAD_GA_FLAG_NAME;

const COPILOT_RELEASE11_FLAG_NAME = "ENABLE_COPILOT_RELEASE11";
const COPILOT_LEASE_QA_FLAG_NAME = "ENABLE_COPILOT_LEASE_QA";
const COPILOT_PORTFOLIO_QA_FLAG_NAME = "ENABLE_COPILOT_PORTFOLIO_QA";
const COPILOT_EXECUTIVE_SUMMARIES_FLAG_NAME = "ENABLE_COPILOT_EXECUTIVE_SUMMARIES";
const COPILOT_WORKFLOW_ASSIST_FLAG_NAME = "ENABLE_COPILOT_WORKFLOW_ASSIST";
const COPILOT_GROUNDED_PROMPTS_FLAG_NAME = "ENABLE_COPILOT_GROUNDED_PROMPTS";
const COPILOT_HALLUCINATION_CHECKS_FLAG_NAME = "ENABLE_COPILOT_HALLUCINATION_CHECKS";

export function isCopilotRelease11Enabled(env: EnvLike = Deno.env): boolean { return readTruthyFlag(env, COPILOT_RELEASE11_FLAG_NAME); }
export function isCopilotLeaseQaEnabled(env: EnvLike = Deno.env): boolean { return readTruthyFlag(env, COPILOT_LEASE_QA_FLAG_NAME); }
export function isCopilotPortfolioQaEnabled(env: EnvLike = Deno.env): boolean { return readTruthyFlag(env, COPILOT_PORTFOLIO_QA_FLAG_NAME); }
export function isCopilotExecutiveSummariesEnabled(env: EnvLike = Deno.env): boolean { return readTruthyFlag(env, COPILOT_EXECUTIVE_SUMMARIES_FLAG_NAME); }
export function isCopilotWorkflowAssistEnabled(env: EnvLike = Deno.env): boolean { return readTruthyFlag(env, COPILOT_WORKFLOW_ASSIST_FLAG_NAME); }
export function isCopilotGroundedPromptsEnabled(env: EnvLike = Deno.env): boolean { return readTruthyFlag(env, COPILOT_GROUNDED_PROMPTS_FLAG_NAME); }
export function isCopilotHallucinationChecksEnabled(env: EnvLike = Deno.env): boolean { return readTruthyFlag(env, COPILOT_HALLUCINATION_CHECKS_FLAG_NAME); }

export const COPILOT_RELEASE11_ENV_NAME = COPILOT_RELEASE11_FLAG_NAME;
export const COPILOT_LEASE_QA_ENV_NAME = COPILOT_LEASE_QA_FLAG_NAME;
export const COPILOT_PORTFOLIO_QA_ENV_NAME = COPILOT_PORTFOLIO_QA_FLAG_NAME;
export const COPILOT_EXECUTIVE_SUMMARIES_ENV_NAME = COPILOT_EXECUTIVE_SUMMARIES_FLAG_NAME;
export const COPILOT_WORKFLOW_ASSIST_ENV_NAME = COPILOT_WORKFLOW_ASSIST_FLAG_NAME;
export const COPILOT_GROUNDED_PROMPTS_ENV_NAME = COPILOT_GROUNDED_PROMPTS_FLAG_NAME;
export const COPILOT_HALLUCINATION_CHECKS_ENV_NAME = COPILOT_HALLUCINATION_CHECKS_FLAG_NAME;
