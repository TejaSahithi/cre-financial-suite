import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { getLeaseFinancialScheduleMode } from "../_shared/extraction/lease-financial-schedule/feature-mode.ts";
import { buildBaseRentScheduleKey, buildBaseRentPeriodKey, buildBaseRentAmountKey } from "../_shared/extraction/lease-financial-schedule/base-rent/base-rent-key.ts";
import { validateBaseRentAmountCandidate, validateBaseRentPeriodCandidate, validateBaseRentScheduleCandidate } from "../_shared/extraction/lease-financial-schedule/base-rent/base-rent-validation.ts";

const context = {
  orgId: "org-a",
  leaseId: "lease-a",
  packageId: "package-a",
  uploadedFileId: "base-file",
  extractionRunId: "run-a",
  generationId: "generation-a",
  activeGenerationId: "generation-a",
  dateExpressions: [
    { id: "expr-contingent-commencement", orgId: "org-a", leaseId: "lease-a", packageId: "package-a", uploadedFileId: "base-file", extractionRunId: "run-a", generationId: "generation-a", status: "valid" },
    { id: "expr-term-end-dependent", orgId: "org-a", leaseId: "lease-a", packageId: "package-a", uploadedFileId: "base-file", extractionRunId: "run-a", generationId: "generation-a", status: "valid" },
  ],
  termCandidates: [
    { id: "term-initial-86-months", orgId: "org-a", leaseId: "lease-a", packageId: "package-a", uploadedFileId: "base-file", extractionRunId: "run-a", generationId: "generation-a", status: "valid" },
    { id: "term-extension-option", orgId: "org-a", leaseId: "lease-a", packageId: "package-a", uploadedFileId: "base-file", extractionRunId: "run-a", generationId: "generation-a", status: "needs_review" },
  ],
  sourceClaims: [
    { id: "claim-base-schedule", orgId: "org-a", leaseId: "lease-a", packageId: "package-a", uploadedFileId: "base-file", extractionRunId: "run-a", generationId: "generation-a", status: "asserted" },
    { id: "claim-free-rent", orgId: "org-a", leaseId: "lease-a", packageId: "package-a", uploadedFileId: "base-file", extractionRunId: "run-a", generationId: "generation-a", status: "asserted" },
    { id: "claim-monthly-6004", orgId: "org-a", leaseId: "lease-a", packageId: "package-a", uploadedFileId: "base-file", extractionRunId: "run-a", generationId: "generation-a", status: "asserted" },
    { id: "claim-annualized-72048", orgId: "org-a", leaseId: "lease-a", packageId: "package-a", uploadedFileId: "base-file", extractionRunId: "run-a", generationId: "generation-a", status: "asserted" },
    { id: "claim-psf-24", orgId: "org-a", leaseId: "lease-a", packageId: "package-a", uploadedFileId: "base-file", extractionRunId: "run-a", generationId: "generation-a", status: "asserted" },
  ],
};

Deno.test("P4.3 integrated flow: base rent schedule, periods and amounts represent the sanitized lease without calculations", async () => {
  const schedule = {
    orgId: "org-a",
    leaseId: "lease-a",
    packageId: "package-a",
    uploadedFileId: "base-file",
    extractionRunId: "run-a",
    generationId: "generation-a",
    sourcePackageDocumentId: "package-document-base",
    sourcePackageEffectiveClaimId: "effective-claim-base-rent",
    termCandidateId: "term-initial-86-months",
    instanceKey: "initial-term-base-rent",
    scheduleStatus: "extracted",
    originType: "extracted",
    scheduleType: "stated_period_schedule",
    currencyCode: "USD",
    scheduleBasis: "explicit_periods",
    startExpressionId: "expr-contingent-commencement",
    endExpressionId: "expr-term-end-dependent",
    sourceClaimIds: ["claim-base-schedule", "claim-free-rent", "claim-monthly-6004", "claim-annualized-72048", "claim-psf-24"],
    producerType: "semantic_extractor",
    producerName: "p4.3_sanitized_fixture",
    providerInvocationId: "provider-invocation-a",
  };
  const scheduleKey = await buildBaseRentScheduleKey(schedule);
  assertEquals(validateBaseRentScheduleCandidate(schedule, context).valid, true);

  const freePeriod = {
    orgId: "org-a",
    leaseId: "lease-a",
    packageId: "package-a",
    scheduleKey,
    generationId: "generation-a",
    periodStatus: "extracted",
    periodType: "free_rent_period",
    sequenceNumber: 1,
    startTermMonth: 1,
    endTermMonth: 2,
    termCandidateId: "term-initial-86-months",
    billingStatus: "fully_abated",
    abatementType: "full",
    sourceClaimId: "claim-free-rent",
  };
  const billedPeriod = {
    ...freePeriod,
    periodType: "standard_rent_period",
    sequenceNumber: 2,
    startTermMonth: 3,
    endTermMonth: 12,
    billingStatus: "billed",
    abatementType: null,
    sourceClaimId: "claim-monthly-6004",
  };
  assertEquals(validateBaseRentPeriodCandidate(freePeriod, context).valid, true);
  assertEquals(validateBaseRentPeriodCandidate(billedPeriod, context).valid, true);

  const billedPeriodKey = await buildBaseRentPeriodKey(billedPeriod);
  const amounts = [
    { amountRole: "stated_monthly_rent", statedAmount: 6004, frequency: "monthly", amountBasis: "per_month", sourceClaimId: "claim-monthly-6004" },
    { amountRole: "annualized_reference", statedAmount: 72048, frequency: "annually", amountBasis: "per_year", sourceClaimId: "claim-annualized-72048" },
    { amountRole: "stated_psf_rate", statedAmount: null, rateValue: 24, rateUnit: "usd_per_square_foot_per_year", frequency: "annually", amountBasis: "per_square_foot_per_year", sourceClaimId: "claim-psf-24" },
  ].map((amount) => ({
    orgId: "org-a",
    scheduleKey,
    periodKey: billedPeriodKey,
    generationId: "generation-a",
    currencyCode: "USD",
    amountStatus: "extracted",
    originType: "extracted",
    ...amount,
  }));
  for (const amount of amounts) {
    assertEquals(validateBaseRentAmountCandidate(amount, context).valid, true);
  }
  assert((await buildBaseRentAmountKey(amounts[0])) !== (await buildBaseRentAmountKey(amounts[1])));
  assert((await buildBaseRentAmountKey(amounts[1])) !== (await buildBaseRentAmountKey(amounts[2])));
});

Deno.test("P4.3 package behavior: assignment preserves economics, explicit amendment bounds changes, and non-rent domains stay outside", () => {
  const sourceAuthority = {
    baseLease: "may_establish_base_schedule",
    assignment: "preserve_inherited_schedule_unless_explicit_amendment_relationship",
    amendment: "may_create_replacement_or_bounded_period_candidates_only",
    rentAddendum: "rent_domain_only",
    commencementCertificate: "date_boundary_only_unless_explicit_rent_claim",
    camEstimate: "outside_p4_3",
    securityDeposit: "outside_p4_3",
    greaseTrapAmortization: "outside_p4_3",
  };

  assertEquals(sourceAuthority.assignment, "preserve_inherited_schedule_unless_explicit_amendment_relationship");
  assertEquals(sourceAuthority.amendment, "may_create_replacement_or_bounded_period_candidates_only");
  assertEquals(sourceAuthority.camEstimate, "outside_p4_3");
  assertEquals(sourceAuthority.securityDeposit, "outside_p4_3");
  assertEquals(sourceAuthority.greaseTrapAmortization, "outside_p4_3");
});

Deno.test("P4.3 feature-mode boundary: default remains off and source has no runtime pipeline call site", async () => {
  assertEquals(getLeaseFinancialScheduleMode({ get: () => undefined }), "off");
  const migration = (await Deno.readTextFile("supabase/migrations/20260850000000_lease_base_rent_schedule_candidates_p4_3.sql")).replace(/^--.*$/gm, "");
  assert(!/runFinancialSchedule|maybeRunFinancialSchedule|parse-pdf-docling|normalize-pdf-output|ingest-file/i.test(migration));
  assert(!/extraction_data|workflow_output|finalize_lease_extraction_for_review/i.test(migration));
});
