// @ts-nocheck
/**
 * compatibility-payload-builder.ts — P2.6.
 *
 * Reproduces the existing Lease Review compatibility payload shape from a
 * FieldProjectionEntry list -- specifically the extraction_data.fields /
 * extraction_data.field_evidence duplicate-key quirk from
 * review-approve/index.ts's buildLeaseReviewDraftPayload() (~1063-1221),
 * which literally calls buildPerFieldEvidence(workflowOutput, row) twice
 * (~1205-1206) and assigns the result to both keys. This builder does the
 * same: one per-field-evidence map, assigned to both `fields` and
 * `field_evidence` -- never deduplicated, since the existing contract
 * expects the duplication (P2 policy: reproduce it, don't "fix" it).
 *
 * Per-field shape mirrors buildPerFieldEvidence()'s real keys
 * (~1877-1891): value, raw_value, raw, source_page, page, source_text,
 * exact_source_text, snippet, source_clause, confidence, confidence_score,
 * extraction_status, field_group. confidence_score here is already 0-100
 * (matching collectConfidenceFromWorkflow's 0-1 -> 0-100 scaling
 * convention) -- callers passing a raw 0-1 confidence must scale before
 * calling this builder.
 *
 * extraction_status mapping from a resolution outcome:
 *   reviewer_replacement/reviewer_accepted/semantic/deterministic -> "extracted"
 *   derived_calculated                                            -> "calculated"
 *   needs_review                                                  -> "conflict_detected"
 *   explicit_status (not_present et al.)                          -> "not_found"
 *   unresolved                                                    -> null (no claim, no status to report --
 *                                                                    never silently becomes "not_found")
 */
import type { FieldProjectionEntry } from "./claims-to-field-projection.ts";

const OUTCOME_TO_EXTRACTION_STATUS: Record<string, string> = {
  reviewer_replacement: "extracted",
  reviewer_accepted: "extracted",
  semantic: "extracted",
  deterministic: "extracted",
  derived_calculated: "calculated",
  needs_review: "conflict_detected",
  explicit_status: "not_found",
};

export interface CompatibilityFieldEntry {
  value: unknown;
  raw_value: unknown;
  raw: unknown;
  source_page: number | null;
  page: number | null;
  source_text: string | null;
  exact_source_text: string | null;
  snippet: string | null;
  source_clause: string | null;
  confidence: number | null;
  confidence_score: number | null;
  extraction_status: string | null;
  field_group: string | null;
}

export function buildPerFieldEvidenceFromProjection(
  entries: FieldProjectionEntry[],
  fieldGroupByConceptKey: Map<string, string>,
): Record<string, CompatibilityFieldEntry> {
  const out: Record<string, CompatibilityFieldEntry> = {};
  for (const entry of entries) {
    if (entry.outcome === "unresolved") continue; // no claim -> not projected at all, never a fabricated row
    const rawCandidate = entry.rawValue ?? entry.sourceText ?? null;
    out[entry.fieldKey] = {
      value: entry.value ?? null,
      raw_value: rawCandidate,
      raw: rawCandidate,
      source_page: entry.sourcePage ?? null,
      page: entry.sourcePage ?? null,
      source_text: entry.sourceText ?? null,
      exact_source_text: entry.sourceText ?? null,
      snippet: entry.sourceText ?? null,
      source_clause: entry.sourceText ?? null,
      confidence: entry.confidence ?? null,
      confidence_score: entry.confidence ?? null,
      extraction_status: OUTCOME_TO_EXTRACTION_STATUS[entry.outcome] ?? null,
      field_group: fieldGroupByConceptKey.get(entry.conceptKey) ?? null,
    };
  }
  return out;
}

export interface CompatibilityExtractionData {
  fields: Record<string, CompatibilityFieldEntry>;
  field_evidence: Record<string, CompatibilityFieldEntry>;
  confidence_scores: Record<string, number>;
}

/**
 * Builds only the claims-ledger-owned slice of extraction_data
 * (fields/field_evidence/confidence_scores) -- custom_fields, rejected_fields,
 * workflow_output, extraction_debug, field_reviews are explicitly untouched
 * by the claims ledger (P2 policy: no broad replacement of extraction_data,
 * never touch workflow_output.expense_rules/cam_profile/budget_preview).
 */
export function buildCompatibilityExtractionDataSlice(
  entries: FieldProjectionEntry[],
  fieldGroupByConceptKey: Map<string, string>,
): CompatibilityExtractionData {
  const perFieldEvidence = buildPerFieldEvidenceFromProjection(entries, fieldGroupByConceptKey);
  const confidenceScores: Record<string, number> = {};
  for (const [key, field] of Object.entries(perFieldEvidence)) {
    if (typeof field.confidence_score === "number") confidenceScores[key] = field.confidence_score;
  }

  return {
    // Literal duplication, matching the real buildLeaseReviewDraftPayload
    // call site exactly -- both keys hold the same content, not a shared
    // reference reduced to one object.
    fields: { ...perFieldEvidence },
    field_evidence: { ...perFieldEvidence },
    confidence_scores: confidenceScores,
  };
}
