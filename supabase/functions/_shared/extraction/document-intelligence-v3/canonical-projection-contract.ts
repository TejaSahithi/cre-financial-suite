// @ts-nocheck

export const CANONICAL_PROJECTION_SCHEMA_VERSION = "canonical-field-projection-v1";
export const CANONICAL_PROJECTION_ALGORITHM_VERSION = "projection-resolution-v1";

export type CanonicalProjectionStatus =
  | "resolved"
  | "resolved_with_warning"
  | "needs_review"
  | "conflict"
  | "not_found"
  | "missing"
  | "missing_source_evidence"
  | "invalid"
  | "suppressed";

export const CANONICAL_PROJECTION_STATUSES: readonly CanonicalProjectionStatus[] = [
  "resolved",
  "resolved_with_warning",
  "needs_review",
  "conflict",
  "not_found",
  "missing",
  "missing_source_evidence",
  "invalid",
  "suppressed",
];

export interface CanonicalRejectedCandidate {
  candidateId: string | null;
  value: unknown;
  normalizedValue: unknown;
  confidence: number | null;
  reasonCodes: string[];
  sourceClaimIds: string[];
  evidenceIds: string[];
}

export interface CanonicalProjectionConflict {
  conflictId: string | null;
  selectedCandidateId: string | null;
  rejectedCandidates: CanonicalRejectedCandidate[];
  reasonCodes: string[];
  summary: string | null;
}

export interface CanonicalDerivationTrace {
  method: string;
  inputs: Record<string, unknown>;
  reasonCodes: string[];
}

export interface CanonicalFieldProjectionReadModel {
  projectionId: string;
  runId: string;
  generationId: string | null;
  canonicalFieldKey: string;
  domain: string;
  value: unknown;
  normalizedValue: unknown;
  displayValue: string | null;
  status: CanonicalProjectionStatus;
  confidence: number | null;
  sourceClaimIds: string[];
  evidenceIds: string[];
  selectedCandidateId: string | null;
  rejectedCandidates: CanonicalRejectedCandidate[];
  conflict: CanonicalProjectionConflict | null;
  derivation: CanonicalDerivationTrace | null;
  provenance: {
    source: "canonical_projection";
    runId: string;
    generationId: string | null;
    projectionVersion: string;
    projectionAlgorithmVersion: string;
  };
}

export function isCanonicalProjectionStatus(value: unknown): value is CanonicalProjectionStatus {
  return CANONICAL_PROJECTION_STATUSES.includes(value as CanonicalProjectionStatus);
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && !(typeof value === "string" && value.trim() === "");
}

function normalizeLegacyProjectionStatus(row: any): CanonicalProjectionStatus {
  const raw = String(row?.status ?? "").trim().toLowerCase();
  if (isCanonicalProjectionStatus(raw)) return raw;
  if (raw === "auto_populated" || raw === "reviewer_confirmed" || raw === "reviewer_edited") {
    return hasValue(row?.normalized_value ?? row?.value) ? "resolved" : "missing";
  }
  if (raw === "needs_review" || raw === "pending_enrichment") return "needs_review";
  if (raw === "missing") return "missing";
  if (raw === "invalid" || raw === "failed") return "invalid";
  return hasValue(row?.normalized_value ?? row?.value) ? "resolved_with_warning" : "missing";
}

export function projectionRowToReadModel(row: any, opts: { generationId?: string | null; domain?: string | null } = {}): CanonicalFieldProjectionReadModel {
  const sourceClaimIds = Array.isArray(row?.source_claim_ids) ? row.source_claim_ids.filter((id: unknown) => typeof id === "string") : [];
  const evidenceIds = Array.isArray(row?.evidence_ids) ? row.evidence_ids.filter((id: unknown) => typeof id === "string") : [];
  const generationId = row?.generation_id ?? opts.generationId ?? null;
  const normalizedValue = row?.normalized_value ?? row?.normalizedValue ?? row?.value ?? null;
  return {
    projectionId: String(row?.id ?? row?.projection_id ?? `${row?.run_id ?? "run"}:${row?.field_key ?? row?.canonical_field_key ?? "field"}`),
    runId: String(row?.run_id ?? ""),
    generationId,
    canonicalFieldKey: String(row?.canonical_field_key ?? row?.field_key ?? ""),
    domain: String(row?.domain ?? row?.canonical_tab ?? opts.domain ?? "lease"),
    value: row?.value ?? null,
    normalizedValue,
    displayValue: row?.display_value ?? (hasValue(normalizedValue) ? String(normalizedValue) : null),
    status: normalizeLegacyProjectionStatus(row),
    confidence: typeof row?.confidence === "number" && Number.isFinite(row.confidence) ? row.confidence : null,
    sourceClaimIds,
    evidenceIds,
    selectedCandidateId: row?.selected_candidate_id ?? null,
    rejectedCandidates: Array.isArray(row?.rejected_candidates) ? row.rejected_candidates : [],
    conflict: row?.conflict ?? null,
    derivation: row?.derivation ?? null,
    provenance: {
      source: "canonical_projection",
      runId: String(row?.run_id ?? ""),
      generationId,
      projectionVersion: row?.projection_schema_version ?? CANONICAL_PROJECTION_SCHEMA_VERSION,
      projectionAlgorithmVersion: row?.projection_algorithm_version ?? CANONICAL_PROJECTION_ALGORITHM_VERSION,
    },
  };
}