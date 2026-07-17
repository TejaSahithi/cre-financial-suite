// @ts-nocheck
/**
 * Azure + Vertex Phase 4E (local implementation) — additive provider
 * provenance, attached to ExtractionPipelineResult.metadata.provenance.
 *
 * Additive JSONB only — normalized_output.metadata already persists
 * `result` verbatim (normalize-pdf-output/index.ts's minimal and final
 * persists both do `normalized_output: result`), so provenance survives
 * there automatically. ui_review_payload.metadata passthrough is handled at
 * the normalize-pdf-output call site, not here.
 */

export type BusinessExtractionMode = "legacy_hybrid" | "vertex_fact_ledger" | "vertex_primary_legacy_fallback";

export interface BusinessExtractionProvenance {
  attempt_id: string;
  requested_provider: BusinessExtractionMode;
  effective_provider: "vertex_fact_ledger" | "legacy_hybrid";
  acceptance_state: string;
  fallback_used: boolean;
  fallback_reason: string | null;
  vertex_attempt_count: number;
  vertex_model: string | null;
  legacy_pipeline_version: string;
  semantic_schema_version: string;
  canonical_layout_schema_version: string | number | null;
  source_content_hash: string | null;
  result_persisted_at: string | null;
  correlation_id: string;
  // Round-3 correction item 6: never let mocked local output be mistaken
  // for real-provider validation. Always present (false in production).
  provider_mocked: boolean;
  mock_scenario: string | null;
}

const LEGACY_PIPELINE_VERSION = "legacy-hybrid-v1";
const SEMANTIC_SCHEMA_VERSION = "lease-semantic-v1";

export function buildProvenance(args: {
  attemptId: string;
  requestedProvider: BusinessExtractionMode;
  effectiveProvider: "vertex_fact_ledger" | "legacy_hybrid";
  acceptanceState: string;
  fallbackUsed: boolean;
  fallbackReason?: string | null;
  vertexAttemptCount: number;
  vertexModel?: string | null;
  canonicalLayoutSchemaVersion?: string | number | null;
  sourceContentHash?: string | null;
  correlationId: string;
  providerMocked?: boolean;
  mockScenario?: string | null;
}): BusinessExtractionProvenance {
  return {
    attempt_id: args.attemptId,
    requested_provider: args.requestedProvider,
    effective_provider: args.effectiveProvider,
    acceptance_state: args.acceptanceState,
    fallback_used: args.fallbackUsed,
    fallback_reason: args.fallbackReason ?? null,
    vertex_attempt_count: args.vertexAttemptCount,
    vertex_model: args.vertexModel ?? null,
    legacy_pipeline_version: LEGACY_PIPELINE_VERSION,
    semantic_schema_version: SEMANTIC_SCHEMA_VERSION,
    canonical_layout_schema_version: args.canonicalLayoutSchemaVersion ?? null,
    source_content_hash: args.sourceContentHash ?? null,
    result_persisted_at: null, // filled in by the caller at actual persist time
    correlation_id: args.correlationId,
    provider_mocked: args.providerMocked ?? false,
    mock_scenario: args.mockScenario ?? null,
  };
}

/** Attaches provenance onto a result's metadata, additively — never
 *  mutates rows/method/warnings/validationErrors. */
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
