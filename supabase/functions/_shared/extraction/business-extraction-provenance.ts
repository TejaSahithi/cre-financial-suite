// @ts-nocheck
/**
 * Azure Document Intelligence + OpenAI business-extraction provenance.
 *
 * "vertex_fact_ledger"/"vertex_primary_legacy_fallback" are legacy names for
 * an internal extraction algorithm choice (fact-ledger vs. rule/table/LLM
 * hybrid), not a vendor selection -- both terminate in OpenAI. They remain
 * accepted as aliases of their openai_* equivalents so existing Supabase
 * secrets, internal debug calls, and already-persisted rows keep working.
 * Any other unrecognized value supplied as a fresh override/env value (as
 * opposed to a value being read back off an already-persisted row) fails
 * closed via UnsupportedBusinessExtractionModeError.
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

export class UnsupportedBusinessExtractionModeError extends Error {
  constructor(public readonly value: string, public readonly source: "override" | "env") {
    super(
      `Unsupported business extraction mode "${value}" (from ${source}). Only ` +
        `"legacy_hybrid", "openai_fact_ledger", "openai_primary_legacy_fallback" ` +
        `(and their legacy vertex_* aliases) are supported.`,
    );
    this.name = "UnsupportedBusinessExtractionModeError";
  }
}

export function normalizeBusinessExtractionMode(
  value: string | null | undefined,
  opts: { source: "override" | "env" | "persisted_row" } = { source: "persisted_row" },
): CanonicalBusinessExtractionMode {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "vertex_fact_ledger") return "openai_fact_ledger";
  if (raw === "vertex_primary_legacy_fallback") return "openai_primary_legacy_fallback";
  if (raw === "openai_fact_ledger" || raw === "openai_primary_legacy_fallback" || raw === "legacy_hybrid") return raw;
  if (!raw) return "legacy_hybrid";
  if (opts.source === "persisted_row") return "legacy_hybrid";
  throw new UnsupportedBusinessExtractionModeError(raw, opts.source);
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
  canonicalLayoutSchemaVersion?: string | number | null;
  sourceContentHash?: string | null;
  correlationId: string;
  providerMocked?: boolean;
  mockScenario?: string | null;
}): BusinessExtractionProvenance {
  return {
    attempt_id: args.attemptId,
    requested_provider: normalizeBusinessExtractionMode(args.requestedProvider),
    effective_provider: args.effectiveProvider === "vertex_fact_ledger" ? "openai_fact_ledger" : args.effectiveProvider,
    acceptance_state: args.acceptanceState,
    fallback_used: args.fallbackUsed,
    fallback_reason: args.fallbackReason ?? null,
    openai_attempt_count: args.openaiAttemptCount ?? 0,
    openai_model: args.openaiModel ?? null,
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
