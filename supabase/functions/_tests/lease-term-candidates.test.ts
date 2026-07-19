// @ts-nocheck
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildLeaseTermKey } from "../_shared/extraction/lease-financial-schedule/terms/lease-term-key.ts";
import {
  LEASE_TERM_CANDIDATE_CONTRACT_VERSION,
  LEASE_TERM_STATUSES,
  LEASE_TERM_TYPES,
  LEASE_TERM_VALIDATION_ERROR_CODES,
} from "../_shared/extraction/lease-financial-schedule/terms/lease-term-types.ts";
import { validateLeaseTermCandidate } from "../_shared/extraction/lease-financial-schedule/terms/lease-term-validation.ts";

const orgId = "org-a";
const leaseId = "lease-a";
const packageId = "package-a";
const uploadedFileId = "file-a";
const extractionRunId = "run-a";
const generationId = "generation-a";

const expressions = [
  { id: "expr-start", orgId, leaseId, packageId, uploadedFileId, extractionRunId, generationId, expressionStatus: "extracted" },
  { id: "expr-end", orgId, leaseId, packageId, uploadedFileId, extractionRunId, generationId, expressionStatus: "unresolved" },
  { id: "expr-notice", orgId, leaseId, packageId, uploadedFileId, extractionRunId, generationId, expressionStatus: "needs_review" },
  { id: "expr-other-package", orgId, leaseId, packageId: "package-b", uploadedFileId, extractionRunId, generationId, expressionStatus: "extracted" },
];

const context = {
  orgId,
  leaseId,
  packageId,
  uploadedFileId,
  extractionRunId,
  generationId,
  activeGenerationId: generationId,
  expressions,
};

function term(overrides = {}) {
  return {
    orgId,
    leaseId,
    packageId,
    uploadedFileId,
    extractionRunId,
    generationId,
    termType: "initial_term",
    termStatus: "valid",
    originType: "extracted",
    instanceKey: "initial-1",
    startExpressionId: "expr-start",
    endExpressionId: "expr-end",
    durationValue: 60,
    durationUnit: "month",
    durationInclusiveRule: "source_defined",
    sequenceNumber: 1,
    sourcePackageEffectiveClaimId: "effective-claim-a",
    sourceClaimIds: ["claim-b", "claim-a"],
    producerType: "deterministic_mapper",
    producerName: "p4.2-test",
    termContractVersion: LEASE_TERM_CANDIDATE_CONTRACT_VERSION,
    metadata: { clause_hash: "abc123" },
    ...overrides,
  };
}

Deno.test("P4.2 term candidates: vocabulary is canonical, unique and complete", () => {
  assertEquals(new Set(LEASE_TERM_TYPES).size, 9);
  assertEquals(new Set(LEASE_TERM_STATUSES).size, 7);
  for (const type of [
    "initial_term",
    "extension_term",
    "renewal_term",
    "option_term",
    "holdover_term",
    "construction_period",
    "rent_free_period",
    "partial_term",
    "unknown_term",
  ]) assert(LEASE_TERM_TYPES.includes(type));
});

Deno.test("P4.2 term key: deterministic identity is provenance/expression based, not confidence, filename or source-claim order", async () => {
  const base = term({ confidence: 0.91, metadata: { filename: "lease-a.pdf", upload_order: 1 }, sourceClaimIds: ["claim-b", "claim-a"] });
  const replay = term({ confidence: 0.12, metadata: { filename: "renamed.pdf", upload_order: 99 }, sourceClaimIds: ["claim-a", "claim-b"] });
  assertEquals(await buildLeaseTermKey(base), await buildLeaseTermKey(replay));
  assert(await buildLeaseTermKey(base) !== await buildLeaseTermKey(term({ generationId: "generation-b" })));
  assert(await buildLeaseTermKey(base) !== await buildLeaseTermKey(term({ startExpressionId: "expr-notice" })));
});

Deno.test("P4.2 term validation: valid initial and option terms preserve expression dependencies without date calculation", () => {
  assertEquals(validateLeaseTermCandidate(term(), context), { valid: true, status: "valid", errorCodes: [] });
  assertEquals(validateLeaseTermCandidate(term({
    termType: "option_term",
    termStatus: "needs_review",
    instanceKey: "option-1",
    startExpressionId: "expr-notice",
    endExpressionId: null,
    durationValue: null,
    durationUnit: null,
    optionExerciseRequired: true,
  }), context).valid, true);
});

Deno.test("P4.2 term validation: rejects invalid vocabulary, stale generations, bad durations and expression context drift", () => {
  assert(validateLeaseTermCandidate(term({ termType: "rent_schedule" }), context).errorCodes.includes(LEASE_TERM_VALIDATION_ERROR_CODES.LEASE_TERM_TYPE_INVALID));
  assert(validateLeaseTermCandidate(term({ durationValue: 12, durationUnit: null }), context).errorCodes.includes(LEASE_TERM_VALIDATION_ERROR_CODES.LEASE_TERM_DURATION_PAIR_INCOMPLETE));
  assert(validateLeaseTermCandidate(term({ sequenceNumber: 0 }), context).errorCodes.includes(LEASE_TERM_VALIDATION_ERROR_CODES.LEASE_TERM_SEQUENCE_INVALID));
  assert(validateLeaseTermCandidate(term({ startExpressionId: "expr-other-package" }), context).errorCodes.includes(LEASE_TERM_VALIDATION_ERROR_CODES.LEASE_TERM_EXPRESSION_CONTEXT_MISMATCH));
  assert(validateLeaseTermCandidate(term(), { ...context, activeGenerationId: "generation-new" }).errorCodes.includes(LEASE_TERM_VALIDATION_ERROR_CODES.LEASE_TERM_GENERATION_STALE));
});

Deno.test("P4.2 term validation: related-document status requires requirement linkage", () => {
  const missingRequirement = validateLeaseTermCandidate(term({
    termStatus: "requires_related_document",
    startExpressionId: null,
    endExpressionId: null,
  }), context);
  assert(missingRequirement.errorCodes.includes(LEASE_TERM_VALIDATION_ERROR_CODES.LEASE_TERM_RELATED_DOCUMENT_REQUIRED));

  const withRequirement = validateLeaseTermCandidate(term({
    termStatus: "requires_related_document",
    startExpressionId: null,
    endExpressionId: null,
    relatedDocumentRequirementId: "requirement-a",
  }), context);
  assertEquals(withRequirement.valid, true);
});

Deno.test("P4.2 term validation: resolved dates, rent schedules and critical-date outputs are outside this phase", () => {
  for (const metadata of [
    { resolved_date: "2026-01-01" },
    { calculated_date: "2026-01-01" },
    { rent_schedule: [] },
    { critical_dates: [] },
  ]) {
    assert(validateLeaseTermCandidate(term({ metadata }), context).errorCodes.includes(LEASE_TERM_VALIDATION_ERROR_CODES.LEASE_TERM_NO_RESOLUTION_ALLOWED));
  }
});
