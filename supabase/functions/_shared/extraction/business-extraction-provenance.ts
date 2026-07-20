// @ts-nocheck
/**
 * Azure Document Intelligence + OpenAI business-extraction provenance.
 *
 * New metadata uses openai_* provider names. Legacy vertex_* provider names
 * are still accepted and mirrored so existing rows, flags, and UI consumers
 * continue to work during the compatibility window.
 */

export type CanonicalBusinessExtractionMode =
  | "legacy_hybrid"
  | "openai_fact_ledger"
  | "openai_primary_legacy_fallback";

export type LegacyBusinessExtractionMode =
  | "vertex_fact_ledger"
  | "vertex_primary_legacy_fallback";

export type BusinessExtractionMode = CanonicalBusinessExtractionMode | LegacyBusinessExtractionMode;

export type EffectiveBusinessExtractionProvider = "openai_fact_ledger" | "legacy_hybrid";

export function normalizeBusinessExtractionMode(value: string | null | undefined): CanonicalBusinessExtractionMode {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "vertex_fact_ledger") return "openai_fact_ledger";
  if (raw === "vertex_primary_legacy_fallback") return "openai_primary_legacy_fallback";
  if (raw === "openai_fact_ledger" || raw === "openai_primary_legacy_fallback" || raw === "legacy_hybrid") return raw;
  return "legacy_hybrid";
}

export interface BusinessExtractionProvenance {
  attempt_id: string;
  requested_provider: CanonicalBusinessExtractionMode;
  effective_provider: EffectiveBusinessExtractionProvider;
  acceptance_state: string;
  fallback_used: boolean;
  fallback_reason: string | null;
  openai_attempt_count: number;
  openai_model: string | null;
  /** @deprecated Compatibility mirror of openai_attempt_count. */
  vertex_attempt_count: number;
  /** @deprecated Compatibility mirror of openai_model. */
  vertex_model: string | null;
  legacy_pipeline_version: string;
  semantic_schema_version: string;
  canonical_layout_schema_version: string | number | null;
  source_content_hash: string | null;
  result_persisted_at: string | null;
  correlation_id: string;
  provider_mocked: boolean;
  mock_scenario: string | null;
}

const LEGACY_PIPELINE_VERSION = "legacy-hybrid-v1";
const SEMANTIC_SCHEMA_VERSION = "lease-semantic-v1";

export function buildProvenance(args: {
  attemptId: string;
  requestedProvider: BusinessExtractionMode;
  effectiveProvider: EffectiveBusinessExtractionProvider | "vertex_fact_ledger";
  acceptanceState: string;
  fallbackUsed: boolean;
  fallbackReason?: string | null;
  openaiAttemptCount?: number;
  openaiModel?: string | null;
  /** @deprecated Use openaiAttemptCount. */
  vertexAttemptCount?: number;
  /** @deprecated Use openaiModel. */
  vertexModel?: string | null;
  canonicalLayoutSchemaVersion?: string | number | null;
  sourceContentHash?: string | null;
  correlationId: string;
  providerMocked?: boolean;
  mockScenario?: string | null;
}): BusinessExtractionProvenance {
  const openaiAttemptCount = args.openaiAttemptCount ?? args.vertexAttemptCount ?? 0;
  const openaiModel = args.openaiModel ?? args.vertexModel ?? null;
  return {
    attempt_id: args.attemptId,
    requested_provider: normalizeBusinessExtractionMode(args.requestedProvider),
    effective_provider: args.effectiveProvider === "vertex_fact_ledger" ? "openai_fact_ledger" : args.effectiveProvider,
    acceptance_state: args.acceptanceState,
    fallback_used: args.fallbackUsed,
    fallback_reason: args.fallbackReason ?? null,
    openai_attempt_count: openaiAttemptCount,
    openai_model: openaiModel,
    vertex_attempt_count: openaiAttemptCount,
    vertex_model: openaiModel,
    legacy_pipeline_version: LEGACY_PIPELINE_VERSION,
    semantic_schema_version: SEMANTIC_SCHEMA_VERSION,
    canonical_layout_schema_version: args.canonicalLayoutSchemaVersion ?? null,
    source_content_hash: args.sourceContentHash ?? null,
    result_persisted_at: null,
    correlation_id: args.correlationId,
    provider_mocked: args.providerMocked ?? false,
    mock_scenario: args.mockScenario ?? null,
  };
}

/** Attaches provenance onto a result's metadata additively. */
export function attachProvenance<T extends { metadata?: Record<string, unknown> }>(
  result: T,
  provenance: BusinessExtractionProvenance,
): T {
  return {
    ...result,
    metadata: {
      ...(result.metadata || {}),
      provenance,
    },
  };
}