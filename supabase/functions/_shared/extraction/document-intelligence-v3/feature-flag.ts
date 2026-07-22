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