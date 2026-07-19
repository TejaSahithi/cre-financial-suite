import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  BASE_RENT_AMOUNT_BASES,
  BASE_RENT_AMOUNT_ROLES,
  BASE_RENT_BILLING_STATUSES,
  BASE_RENT_PERIOD_TYPES,
} from "../_shared/extraction/lease-financial-schedule/base-rent/base-rent-types.ts";
import {
  buildBaseRentAmountKey,
  buildBaseRentPeriodKey,
} from "../_shared/extraction/lease-financial-schedule/base-rent/base-rent-key.ts";
import {
  validateBaseRentAmountCandidate,
  validateBaseRentPeriodCandidate,
  validateBaseRentPeriodSet,
} from "../_shared/extraction/lease-financial-schedule/base-rent/base-rent-validation.ts";

const context = {
  orgId: "org-a",
  leaseId: "lease-a",
  packageId: "package-a",
  uploadedFileId: "file-a",
  extractionRunId: "run-a",
  generationId: "generation-a",
  activeGenerationId: "generation-a",
  dateExpressions: [
    { id: "expr-rent-start", orgId: "org-a", leaseId: "lease-a", packageId: "package-a", uploadedFileId: "file-a", extractionRunId: "run-a", generationId: "generation-a", status: "valid" },
    { id: "expr-rent-end", orgId: "org-a", leaseId: "lease-a", packageId: "package-a", uploadedFileId: "file-a", extractionRunId: "run-a", generationId: "generation-a", status: "valid" },
  ],
  termCandidates: [
    { id: "term-86-months", orgId: "org-a", leaseId: "lease-a", packageId: "package-a", uploadedFileId: "file-a", extractionRunId: "run-a", generationId: "generation-a", status: "valid" },
  ],
  sourceClaims: [
    { id: "claim-free-rent", orgId: "org-a", leaseId: "lease-a", packageId: "package-a", uploadedFileId: "file-a", extractionRunId: "run-a", generationId: "generation-a", status: "asserted" },
    { id: "claim-monthly", orgId: "org-a", leaseId: "lease-a", packageId: "package-a", uploadedFileId: "file-a", extractionRunId: "run-a", generationId: "generation-a", status: "asserted" },
    { id: "claim-annualized", orgId: "org-a", leaseId: "lease-a", packageId: "package-a", uploadedFileId: "file-a", extractionRunId: "run-a", generationId: "generation-a", status: "asserted" },
    { id: "claim-psf", orgId: "org-a", leaseId: "lease-a", packageId: "package-a", uploadedFileId: "file-a", extractionRunId: "run-a", generationId: "generation-a", status: "asserted" },
  ],
};

const scheduleKey = "schedule-key-a";
const freePeriod = {
  orgId: "org-a",
  scheduleKey,
  leaseId: "lease-a",
  packageId: "package-a",
  generationId: "generation-a",
  periodStatus: "extracted",
  periodType: "free_rent_period",
  sequenceNumber: 1,
  startTermMonth: 1,
  endTermMonth: 2,
  termCandidateId: "term-86-months",
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
  sourceClaimId: "claim-monthly",
};

Deno.test("P4.3 periods: vocabulary supports free, partial and unresolved periods without resolved dates", () => {
  assertEquals(BASE_RENT_PERIOD_TYPES, [
    "standard_rent_period",
    "free_rent_period",
    "partial_period",
    "holdover_period",
    "unresolved_period",
  ]);
  assertEquals(BASE_RENT_BILLING_STATUSES, ["billed", "fully_abated", "partially_abated", "not_yet_determined", "not_applicable"]);
  assertEquals(validateBaseRentPeriodCandidate({ ...billedPeriod, startExpressionId: "expr-rent-start", endExpressionId: "expr-rent-end" }, context).valid, true);
});

Deno.test("P4.3 periods: months 1-2 free and months 3-12 billed are accepted without filling later gaps", () => {
  assertEquals(validateBaseRentPeriodCandidate(freePeriod, context).valid, true);
  assertEquals(validateBaseRentPeriodCandidate(billedPeriod, context).valid, true);
  const setResult = validateBaseRentPeriodSet([freePeriod, billedPeriod, { ...billedPeriod, sequenceNumber: 3, startTermMonth: 24, endTermMonth: 30 }]);
  assert(setResult.errorCodes.includes("RENT_PERIOD_GAP"));
  assertEquals(setResult.gaps, [[13, 23]]);
});

Deno.test("P4.3 periods: invalid ranges, overlaps and proration calculations are rejected", () => {
  assert(validateBaseRentPeriodCandidate({ ...billedPeriod, startTermMonth: 12, endTermMonth: 3 }, context).errorCodes.includes("RENT_PERIOD_RANGE_INVALID"));
  assert(validateBaseRentPeriodCandidate({ ...freePeriod, billingStatus: "billed" }, context).errorCodes.includes("RENT_PERIOD_ABATEMENT_INVALID"));
  assert(validateBaseRentPeriodCandidate({ ...billedPeriod, periodType: "partial_period", metadata: { prorated_amount: 1200 } }, context).errorCodes.includes("RENT_NO_CALCULATION_ALLOWED"));
  assert(validateBaseRentPeriodSet([billedPeriod, { ...billedPeriod, sequenceNumber: 3, startTermMonth: 10, endTermMonth: 18 }]).errorCodes.includes("RENT_PERIOD_OVERLAP"));
  assertEquals(validateBaseRentPeriodSet([billedPeriod, { ...billedPeriod, periodStatus: "ambiguous", sequenceNumber: 3, startTermMonth: 10, endTermMonth: 18 }]).errorCodes, []);
});

Deno.test("P4.3 period key: stable boundary identity changes with generation but not display text", async () => {
  const key = await buildBaseRentPeriodKey(billedPeriod);
  const withDisplayText = await buildBaseRentPeriodKey({ ...billedPeriod, metadata: { display: "Months 3-12" } });
  const differentBoundary = await buildBaseRentPeriodKey({ ...billedPeriod, endTermMonth: 11 });
  assertEquals(key, withDisplayText);
  assert(key !== differentBoundary);
});

Deno.test("P4.3 amount vocabulary keeps monthly, annual and PSF representations distinct", () => {
  assert(BASE_RENT_AMOUNT_ROLES.includes("stated_monthly_rent"));
  assert(BASE_RENT_AMOUNT_ROLES.includes("annualized_reference"));
  assert(BASE_RENT_AMOUNT_ROLES.includes("stated_psf_rate"));
  assert(BASE_RENT_AMOUNT_BASES.includes("per_square_foot_per_year"));
});

Deno.test("P4.3 amounts: 6004 monthly, 72048 annualized and 24 PSF stay separate records", async () => {
  const periodKey = await buildBaseRentPeriodKey(billedPeriod);
  const monthly = {
    orgId: "org-a",
    scheduleKey,
    periodKey,
    generationId: "generation-a",
    amountRole: "stated_monthly_rent",
    statedAmount: 6004,
    currencyCode: "USD",
    frequency: "monthly",
    amountBasis: "per_month",
    amountStatus: "extracted",
    originType: "extracted",
    sourceClaimId: "claim-monthly",
  };
  const annualized = { ...monthly, amountRole: "annualized_reference", statedAmount: 72048, frequency: "annually", amountBasis: "per_year", sourceClaimId: "claim-annualized" };
  const psf = { ...monthly, amountRole: "stated_psf_rate", statedAmount: null, frequency: "annually", amountBasis: "per_square_foot_per_year", rateValue: 24, rateUnit: "usd_per_square_foot_per_year", sourceClaimId: "claim-psf" };

  assertEquals(validateBaseRentAmountCandidate(monthly, context).valid, true);
  assertEquals(validateBaseRentAmountCandidate(annualized, context).valid, true);
  assertEquals(validateBaseRentAmountCandidate(psf, context).valid, true);
  assert((await buildBaseRentAmountKey(monthly)) !== (await buildBaseRentAmountKey(annualized)));
  assert((await buildBaseRentAmountKey(annualized)) !== (await buildBaseRentAmountKey(psf)));
});

Deno.test("P4.3 amounts: annualized, PSF, missing and negative values do not become billed rent silently", () => {
  const base = {
    orgId: "org-a",
    scheduleKey,
    periodKey: "period-key-a",
    generationId: "generation-a",
    amountRole: "billed_base_rent",
    statedAmount: 72048,
    currencyCode: "USD",
    frequency: "annually",
    amountBasis: "per_year",
    amountStatus: "extracted",
    originType: "extracted",
    sourceClaimId: "claim-annualized",
  };
  assert(validateBaseRentAmountCandidate(base, context).errorCodes.includes("RENT_ANNUALIZED_BILLED_CONFLATION"));
  assert(validateBaseRentAmountCandidate({ ...base, amountRole: "stated_psf_rate", amountBasis: "per_month", statedAmount: 24 }, context).errorCodes.includes("RENT_PSF_CONVERSION_NOT_ALLOWED"));
  assert(validateBaseRentAmountCandidate({ ...base, amountRole: "stated_monthly_rent", amountBasis: "per_month", statedAmount: null }, context).errorCodes.includes("RENT_AMOUNT_SOURCE_MISSING"));
  assert(validateBaseRentAmountCandidate({ ...base, amountRole: "stated_monthly_rent", amountBasis: "per_month", frequency: "monthly", statedAmount: -10 }, context).errorCodes.includes("RENT_NEGATIVE_AMOUNT_NEEDS_REVIEW"));
  assertEquals(validateBaseRentAmountCandidate({ ...base, amountRole: "abatement_amount", amountBasis: "fixed_amount", frequency: "one_time", statedAmount: -10 }, context).valid, true);
});
