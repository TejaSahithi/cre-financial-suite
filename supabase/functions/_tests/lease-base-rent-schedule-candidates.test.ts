import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  BASE_RENT_ORIGIN_TYPES,
  BASE_RENT_REVIEW_OPERATIONS,
  BASE_RENT_SCHEDULE_STATUSES,
  BASE_RENT_SCHEDULE_TYPES,
  LEASE_BASE_RENT_SCHEDULE_CONTRACT_VERSION,
} from "../_shared/extraction/lease-financial-schedule/base-rent/base-rent-types.ts";
import { buildBaseRentScheduleKey } from "../_shared/extraction/lease-financial-schedule/base-rent/base-rent-key.ts";
import { validateBaseRentScheduleCandidate } from "../_shared/extraction/lease-financial-schedule/base-rent/base-rent-validation.ts";

const orgId = "org-a";
const leaseId = "lease-a";
const packageId = "package-a";
const uploadedFileId = "file-a";
const extractionRunId = "run-a";
const generationId = "generation-a";
const termCandidateId = "term-initial";
const startExpressionId = "expr-start";
const endExpressionId = "expr-end";

const context = {
  orgId,
  leaseId,
  packageId,
  uploadedFileId,
  extractionRunId,
  generationId,
  activeGenerationId: generationId,
  dateExpressions: [
    { id: startExpressionId, orgId, leaseId, packageId, uploadedFileId, extractionRunId, generationId, status: "valid" },
    { id: endExpressionId, orgId, leaseId, packageId, uploadedFileId, extractionRunId, generationId, status: "valid" },
  ],
  termCandidates: [
    { id: termCandidateId, orgId, leaseId, packageId, uploadedFileId, extractionRunId, generationId, status: "valid" },
  ],
  sourceClaims: [
    { id: "claim-monthly", orgId, leaseId, packageId, uploadedFileId, extractionRunId, generationId, status: "asserted" },
    { id: "claim-annual", orgId, leaseId, packageId, uploadedFileId, extractionRunId, generationId, status: "asserted" },
  ],
};

const schedule = {
  orgId,
  leaseId,
  packageId,
  uploadedFileId,
  extractionRunId,
  generationId,
  sourcePackageDocumentId: "package-document-base",
  sourcePackageEffectiveClaimId: "effective-claim-rent",
  termCandidateId,
  instanceKey: "initial-base-rent",
  scheduleStatus: "extracted",
  originType: "extracted",
  scheduleType: "stated_period_schedule",
  currencyCode: "USD",
  scheduleBasis: "explicit_periods",
  startExpressionId,
  endExpressionId,
  sourceClaimIds: ["claim-annual", "claim-monthly"],
  producerType: "semantic_extractor",
  producerName: "p4.3_test_fixture",
  providerInvocationId: "provider-invocation-a",
  confidence: 0.91,
  metadata: { fixture: "sanitized_complex_lease" },
};

Deno.test("P4.3 base-rent schedules: vocabulary is canonical, unique and complete", () => {
  assertEquals(LEASE_BASE_RENT_SCHEDULE_CONTRACT_VERSION, "lease-base-rent-schedules-v1");
  assertEquals(new Set(BASE_RENT_SCHEDULE_TYPES).size, BASE_RENT_SCHEDULE_TYPES.length);
  assertEquals(BASE_RENT_SCHEDULE_TYPES, [
    "stated_period_schedule",
    "fixed_step_schedule",
    "fixed_increase_schedule",
    "percentage_increase_schedule",
    "cpi_linked_schedule",
    "formula_schedule",
    "mixed_schedule",
    "unresolved_schedule",
  ]);
  assertEquals(BASE_RENT_SCHEDULE_STATUSES, [
    "extracted",
    "unresolved",
    "ambiguous",
    "needs_review",
    "manual_required",
    "requires_related_document",
    "not_present",
    "not_applicable",
    "unreadable",
    "extraction_failed",
  ]);
  assertEquals(BASE_RENT_ORIGIN_TYPES, ["extracted", "reviewer", "derived", "calculated", "legacy_adapter", "system_projection"]);
  assert(BASE_RENT_REVIEW_OPERATIONS.includes("classify_annualized_vs_billed"));
});

Deno.test("P4.3 schedule key: deterministic identity ignores ordering, confidence and display metadata", async () => {
  const key = await buildBaseRentScheduleKey(schedule);
  const reordered = await buildBaseRentScheduleKey({
    ...schedule,
    sourceClaimIds: ["claim-monthly", "claim-annual"],
    confidence: 0.12,
    metadata: { formatted_display_text: "Months 3-12: $6,004/mo" },
  });
  const newGeneration = await buildBaseRentScheduleKey({ ...schedule, generationId: "generation-b" });

  assertEquals(key, reordered);
  assert(key !== newGeneration);
});

Deno.test("P4.3 schedule validation: explicit schedule preserves provenance without calculation", () => {
  const result = validateBaseRentScheduleCandidate(schedule, context);
  assertEquals(result, { valid: true, status: "valid", errorCodes: [] });
});

Deno.test("P4.3 schedule validation: rejects cross-context, stale generation and producer provenance drift", () => {
  assert(validateBaseRentScheduleCandidate({ ...schedule, orgId: "org-b" }, context).errorCodes.includes("RENT_SCHEDULE_CONTEXT_INVALID"));
  assert(validateBaseRentScheduleCandidate(schedule, { ...context, activeGenerationId: "generation-b" }).errorCodes.includes("RENT_SCHEDULE_GENERATION_STALE"));
  assert(validateBaseRentScheduleCandidate({ ...schedule, providerInvocationId: null }, context).errorCodes.includes("RENT_PRODUCER_PROVENANCE_INVALID"));
  assert(validateBaseRentScheduleCandidate({
    ...schedule,
    originType: "reviewer",
    producerType: "reviewer",
    providerInvocationId: "provider-should-not-be-here",
  }, context).errorCodes.includes("RENT_PRODUCER_PROVENANCE_INVALID"));
});

Deno.test("P4.3 schedule validation: calculation, resolved dates and generated schedules are out of scope", () => {
  const result = validateBaseRentScheduleCandidate({
    ...schedule,
    metadata: {
      calculated_monthly_rent: 6004,
      resolved_date: "2026-01-01",
      expanded_periods: [{ month: 13 }],
    },
  }, context);
  assert(result.errorCodes.includes("RENT_NO_CALCULATION_ALLOWED"));
});
