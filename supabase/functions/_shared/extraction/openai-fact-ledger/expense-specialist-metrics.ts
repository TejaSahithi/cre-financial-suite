// @ts-nocheck
/**
 * Phase 5 expense-specialist shadow comparison metrics.
 *
 * Unlike strict-outputs-shadow.ts's FieldDiff (a 1:1 field-value comparison
 * that assumes both sides share the same flat field vocabulary), obligations
 * aren't flat fields -- this compares CONCEPTS instead, via a small explicit
 * concept-mapping table (reusing the exact same authoritative-field
 * correspondences canonical/expense-specialist-claims.ts's
 * safeExactCanonicalMappingExists already established as genuinely safe,
 * rather than inventing a second, disconnected table).
 *
 * Old domain stays authoritative throughout -- nothing here writes to or
 * reads back into the authoritative pipeline; this only produces an
 * inspectable comparison for a human to review.
 */

import type { ExtractedClaim } from "../canonical/extracted-claim.ts";
import type { ExpenseSpecialistShadowRecord } from "./expense-specialist-shadow.ts";
import { expenseSpecialistRecordsToClaims, proposeClaimPlacements } from "../canonical/expense-specialist-claims.ts";

export interface ExpenseSpecialistShadowMetrics {
  technicalStatuses: Record<string, string>;

  authoritativePopulatedFieldCount: number;
  specialistObligationCount: number;

  specialistClaimsWithEvidence: number;
  specialistClaimsNeedingReview: number;
  specialistInvalidEvidenceCount: number;

  conceptsOnlyInAuthoritative: string[];
  conceptsOnlyInSpecialists: string[];

  responsibilityDisagreements: number;
  economicTreatmentDisagreements: number;

  possibleCanonicalMappings: number;
  proposedDynamicRows: number;

  /** A mapper-proposed authoritative value that vanished before
   *  post-verification without an explicit verifier "null" decision -- the
   *  exact strict-outputs-shadow.ts definition, reused, not reinvented.
   *  Must stay 0 on a healthy pipeline; 0 by construction whenever the
   *  caller has no pre/post-verification snapshot to compare (nothing to
   *  detect a drop from, not a claim that none occurred). */
  authoritativeDroppedDownstreamCount: number;
}

const EVIDENCE_REVIEW_REASONS = new Set([
  "populated_claim_without_evidence", "evidence_quote_not_found", "evidence_page_mismatch",
]);

interface ResponsibilityConceptMapping {
  concept: string;
  authoritativeFieldKey: string;
  /** Which claims (by fieldCode suffix) represent this same concept. */
  matchesClaim: (claim: ExtractedClaim) => boolean;
}

// The exact same 4 correspondences expense-specialist-claims.ts's
// safeExactCanonicalMappingExists already established as genuinely safe --
// reused here, not a second table that could silently drift from it.
const RESPONSIBILITY_CONCEPT_MAPPINGS: ResponsibilityConceptMapping[] = [
  { concept: "electric utility responsibility", authoritativeFieldKey: "electric_responsibility", matchesClaim: (c) => c.fieldCode.endsWith(".electricity.responsibleParty") },
  { concept: "water/sewer utility responsibility", authoritativeFieldKey: "water_sewer_responsibility", matchesClaim: (c) => (c.fieldCode.includes(".water.") || c.fieldCode.includes(".sewer.")) && c.fieldCode.endsWith(".responsibleParty") },
  { concept: "real estate tax responsibility", authoritativeFieldKey: "responsibility_taxes", matchesClaim: (c) => c.fieldCode.startsWith("expense.tax.real_estate_tax.") && c.fieldCode.endsWith(".responsibleParty") },
  { concept: "property insurance responsibility", authoritativeFieldKey: "insurance_responsibility", matchesClaim: (c) => c.fieldCode.startsWith("insurance.building.") && c.fieldCode.endsWith(".obligatedParty") },
];

function normalizedValuesEqual(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

export interface ComputeExpenseSpecialistShadowMetricsArgs {
  records: ExpenseSpecialistShadowRecord[];
  claims: ExtractedClaim[];
  /** Authoritative field values relevant to expense concepts (e.g.
   *  expenses_and_cam/operating_obligations' resolved values), keyed by
   *  field key -- {} if unavailable. Drives authoritativePopulatedFieldCount
   *  and the concept-comparison fields. */
  authoritativeFields: Record<string, { value: unknown } | undefined>;
  /** Pre-verification authoritative values, for the drop-detection
   *  computation -- see authoritativeDroppedDownstreamCount. Both default
   *  to {} (nothing to compare -> 0 drops detected, not a false "healthy"
   *  claim). */
  authoritativeRawFields?: Record<string, { value: unknown } | undefined>;
  explicitlyNulledFields?: ReadonlySet<string>;
}

export function computeExpenseSpecialistShadowMetrics(
  args: ComputeExpenseSpecialistShadowMetricsArgs,
): ExpenseSpecialistShadowMetrics {
  const { records, claims, authoritativeFields } = args;
  const authoritativeRawFields = args.authoritativeRawFields ?? {};
  const explicitlyNulledFields = args.explicitlyNulledFields ?? new Set<string>();

  const technicalStatuses: Record<string, string> = {};
  for (const record of records) technicalStatuses[record.domain] = record.technicalStatus;

  const authoritativePopulatedFieldCount = Object.values(authoritativeFields).filter((f) => f?.value != null).length;
  const specialistObligationCount = records.reduce((sum, r) => sum + (r.obligations?.length ?? 0), 0);

  const specialistClaimsWithEvidence = claims.filter((c) => c.evidence.length > 0).length;
  const specialistClaimsNeedingReview = claims.filter((c) => c.requiresReview).length;
  const specialistInvalidEvidenceCount = claims.filter((c) => c.reviewReasons.some((r) => EVIDENCE_REVIEW_REASONS.has(r))).length;

  const conceptsOnlyInAuthoritative: string[] = [];
  const conceptsOnlyInSpecialists: string[] = [];
  let responsibilityDisagreements = 0;
  for (const mapping of RESPONSIBILITY_CONCEPT_MAPPINGS) {
    const authoritativeValue = authoritativeFields[mapping.authoritativeFieldKey]?.value ?? null;
    const specialistClaim = claims.find(mapping.matchesClaim);
    const specialistValue = specialistClaim?.normalizedValue ?? null;
    if (authoritativeValue != null && specialistValue == null) conceptsOnlyInAuthoritative.push(mapping.concept);
    else if (authoritativeValue == null && specialistValue != null) conceptsOnlyInSpecialists.push(mapping.concept);
    else if (authoritativeValue != null && specialistValue != null && !normalizedValuesEqual(authoritativeValue, specialistValue)) {
      responsibilityDisagreements++;
    }
  }

  // economicTreatment has no clean authoritative-field counterpart in this
  // phase (no existing UI field captures "included in rent" vs "direct
  // cost" as a first-class concept) -- 0 by construction, an honest
  // "nothing comparable" rather than a fabricated signal. A later phase
  // with a real authoritative counterpart can extend this the same way
  // RESPONSIBILITY_CONCEPT_MAPPINGS was built.
  const economicTreatmentDisagreements = 0;

  const { canonicalMappings, dynamicRows } = proposeClaimPlacements(claims);

  let authoritativeDroppedDownstreamCount = 0;
  for (const [fieldKey, rawField] of Object.entries(authoritativeRawFields)) {
    const rawValue = rawField?.value ?? null;
    if (rawValue == null) continue;
    const postValue = authoritativeFields[fieldKey]?.value ?? null;
    if (postValue == null && !explicitlyNulledFields.has(fieldKey)) authoritativeDroppedDownstreamCount++;
  }

  return {
    technicalStatuses,
    authoritativePopulatedFieldCount,
    specialistObligationCount,
    specialistClaimsWithEvidence,
    specialistClaimsNeedingReview,
    specialistInvalidEvidenceCount,
    conceptsOnlyInAuthoritative,
    conceptsOnlyInSpecialists,
    responsibilityDisagreements,
    economicTreatmentDisagreements,
    possibleCanonicalMappings: canonicalMappings.length,
    proposedDynamicRows: dynamicRows.length,
    authoritativeDroppedDownstreamCount,
  };
}

/** Convenience one-shot: converts records to claims, then computes metrics.
 *  Equivalent to calling expenseSpecialistRecordsToClaims() +
 *  computeExpenseSpecialistShadowMetrics() separately -- provided since
 *  orchestrator.ts needs both the claims (for canonical_claims diagnostics)
 *  and the metrics, and most other callers only need the metrics. */
export function buildExpenseSpecialistShadowMetrics(args: {
  records: ExpenseSpecialistShadowRecord[];
  context: { organizationId: string; fileId: string; generationId: string; extractionRunId: string | null };
  doclingRaw: Record<string, unknown> | null;
  authoritativeFields: Record<string, { value: unknown } | undefined>;
  authoritativeRawFields?: Record<string, { value: unknown } | undefined>;
  explicitlyNulledFields?: ReadonlySet<string>;
}): { claims: ExtractedClaim[]; metrics: ExpenseSpecialistShadowMetrics } {
  const claims = expenseSpecialistRecordsToClaims(args.records, args.context, args.doclingRaw);
  const metrics = computeExpenseSpecialistShadowMetrics({
    records: args.records, claims, authoritativeFields: args.authoritativeFields,
    authoritativeRawFields: args.authoritativeRawFields, explicitlyNulledFields: args.explicitlyNulledFields,
  });
  return { claims, metrics };
}
