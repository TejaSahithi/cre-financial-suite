// @ts-nocheck
/**
 * Canonical Claim/Evidence Layer (Phase 2) — ExtractedClaim.
 *
 * One internal fact contract every downstream stage can eventually converge
 * on. This phase is additive only (LEASE_CANONICAL_CLAIMS_V1, default off):
 * claims are generated ALONGSIDE the existing mapper/verifier/Truth
 * Assembly/ui_review_payload pipeline, attached to
 * extractionDebug.openai_fact_ledger.canonical_claims for inspection, and
 * do not replace or mutate anything authoritative. See claim-converters.ts
 * for how existing pipeline shapes (FieldAssignment, StrictExtractedField,
 * FieldVerificationResult, ExtractedField) become/came-from claims.
 */

import type { ClaimStatus, ClaimVerificationStatus } from "./claim-status.ts";
import type { EvidenceReference } from "./evidence-reference.ts";

export interface ExtractedClaim<T = unknown> {
  claimId: string;

  organizationId: string;
  fileId: string;
  generationId: string;
  extractionRunId: string | null;

  /** LlmCallDomain string (section-router.ts) -- the real 5-domain
   *  vocabulary, not a placeholder. */
  domain: string;
  fieldCode: string;
  /** Resolved via field-contract.ts's resolveCanonicalKey() -- no new alias
   *  table. Equal to fieldCode when fieldCode has no registered alias. */
  canonicalFieldCode: string;

  status: ClaimStatus;
  verificationStatus: ClaimVerificationStatus;

  rawValue: string | null;
  normalizedValue: T | null;

  evidence: EvidenceReference[];

  /** Always null in this phase -- amendment/package resolution is a later,
   *  separate phase (Phase 5+ of the broader roadmap). */
  controllingDocumentId: string | null;
  sourceModel: string | null;
  promptVersion: string | null;
  schemaVersion: string | null;

  requiresReview: boolean;
  reviewReasons: string[];

  createdAt: string;
}
