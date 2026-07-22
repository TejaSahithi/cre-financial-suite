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
