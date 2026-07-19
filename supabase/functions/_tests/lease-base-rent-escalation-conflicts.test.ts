import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  BASE_RENT_CONFLICT_TYPES,
  BASE_RENT_ESCALATION_TYPES,
  BASE_RENT_LINK_ROLES,
} from "../_shared/extraction/lease-financial-schedule/base-rent/base-rent-types.ts";
import { buildBaseRentEscalationKey } from "../_shared/extraction/lease-financial-schedule/base-rent/base-rent-key.ts";
import { validateBaseRentEscalationCandidate } from "../_shared/extraction/lease-financial-schedule/base-rent/base-rent-validation.ts";

const context = {
  orgId: "org-a",
  leaseId: "lease-a",
  packageId: "package-a",
  uploadedFileId: "file-a",
  extractionRunId: "run-a",
  generationId: "generation-a",
  activeGenerationId: "generation-a",
  sourceClaims: [
    { id: "claim-step", orgId: "org-a", leaseId: "lease-a", packageId: "package-a", uploadedFileId: "file-a", extractionRunId: "run-a", generationId: "generation-a", status: "asserted" },
    { id: "claim-cpi", orgId: "org-a", leaseId: "lease-a", packageId: "package-a", uploadedFileId: "file-a", extractionRunId: "run-a", generationId: "generation-a", status: "asserted" },
  ],
};

Deno.test("P4.3 escalation/conflict vocabulary preserves explicit instructions and open conflicts", () => {
  assertEquals(BASE_RENT_ESCALATION_TYPES, [
    "stated_next_amount",
    "fixed_amount_increase",
    "fixed_percentage_increase",
    "cpi_adjustment",
    "periodic_step",
    "custom_formula",
    "unresolved_escalation",
  ]);
  assert(BASE_RENT_CONFLICT_TYPES.includes("annualized_vs_billed_role_conflict"));
  assert(BASE_RENT_CONFLICT_TYPES.includes("amendment_sequence_ambiguous"));
  assert(BASE_RENT_LINK_ROLES.includes("contradictory_source"));
});

Deno.test("P4.3 escalation candidates: explicit step, percentage and CPI instructions are stored without expansion", () => {
  const fixedStep = {
    orgId: "org-a",
    scheduleKey: "schedule-key-a",
    generationId: "generation-a",
    escalationType: "stated_next_amount",
    appliesAfterPeriodKey: "period-months-3-12",
    increaseAmount: 6500,
    frequency: "monthly",
    escalationStatus: "extracted",
    sourceClaimId: "claim-step",
  };
  const percentage = { ...fixedStep, escalationType: "fixed_percentage_increase", increaseAmount: null, increasePercentage: 3 };
  const cpi = { ...fixedStep, escalationType: "cpi_adjustment", increaseAmount: null, indexName: "CPI-U", formulaDefinition: { index_name: "CPI-U" }, sourceClaimId: "claim-cpi" };

  assertEquals(validateBaseRentEscalationCandidate(fixedStep, context).valid, true);
  assertEquals(validateBaseRentEscalationCandidate(percentage, context).valid, true);
  assertEquals(validateBaseRentEscalationCandidate(cpi, context).valid, true);
});

Deno.test("P4.3 escalation candidates: CPI values and generated periods are never produced here", () => {
  const result = validateBaseRentEscalationCandidate({
    orgId: "org-a",
    scheduleKey: "schedule-key-a",
    generationId: "generation-a",
    escalationType: "cpi_adjustment",
    formulaDefinition: { cpi_value: 278.8, generated_periods: [{ month: 13 }] },
    recurrenceDefinition: { expanded_periods: [{ month: 13 }] },
    frequency: "annually",
    escalationStatus: "extracted",
    sourceClaimId: "claim-cpi",
  }, context);

  assert(result.errorCodes.includes("RENT_ESCALATION_EXPANSION_NOT_ALLOWED"));
});

Deno.test("P4.3 escalation key: instruction identity is source and boundary based, not upload order", async () => {
  const key = await buildBaseRentEscalationKey({
    orgId: "org-a",
    scheduleKey: "schedule-key-a",
    generationId: "generation-a",
    escalationType: "fixed_percentage_increase",
    effectiveTermMonth: 13,
    increasePercentage: 3,
    sourceClaimId: "claim-step",
    escalationStatus: "extracted",
  });
  const sameWithoutUploadOrder = await buildBaseRentEscalationKey({
    orgId: "org-a",
    scheduleKey: "schedule-key-a",
    generationId: "generation-a",
    escalationType: "fixed_percentage_increase",
    effectiveTermMonth: 13,
    increasePercentage: 99,
    sourceClaimId: "claim-step",
    escalationStatus: "extracted",
  });
  const differentBoundary = await buildBaseRentEscalationKey({
    orgId: "org-a",
    scheduleKey: "schedule-key-a",
    generationId: "generation-a",
    escalationType: "fixed_percentage_increase",
    effectiveTermMonth: 25,
    sourceClaimId: "claim-step",
    escalationStatus: "extracted",
  });

  assertEquals(key, sameWithoutUploadOrder);
  assert(key !== differentBoundary);
});

Deno.test("P4.3 scope separation: CAM, deposits, TI allowance and amortization are absent from base-rent role vocabularies", () => {
  const joined = [
    ...BASE_RENT_ESCALATION_TYPES,
    ...BASE_RENT_CONFLICT_TYPES,
    ...BASE_RENT_LINK_ROLES,
  ].join(" ");
  assert(!joined.includes("cam_estimate"));
  assert(!joined.includes("security_deposit"));
  assert(!joined.includes("ti_allowance"));
  assert(!joined.includes("grease_trap"));
});
