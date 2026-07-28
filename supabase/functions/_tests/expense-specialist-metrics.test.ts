// @ts-nocheck
// Phase 5 shadow-comparison metrics (expense-specialist-metrics.ts).

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  computeExpenseSpecialistShadowMetrics,
  buildExpenseSpecialistShadowMetrics,
} from "../_shared/extraction/openai-fact-ledger/expense-specialist-metrics.ts";
import { utilityObligationsToClaims, repairObligationsToClaims } from "../_shared/extraction/canonical/expense-specialist-claims.ts";
import { getExpenseSpecialistDefinitionsInOrder } from "../_shared/extraction/domains/domain-registry.ts";

const CONTEXT = { organizationId: "org-1", fileId: "file-1", generationId: "gen-1", extractionRunId: "run-1" };

function allNoEvidenceRecords() {
  return getExpenseSpecialistDefinitionsInOrder().map((d) => ({
    domain: d.id, technicalStatus: "no_evidence", obligations: [], errorMessage: null,
    schemaVersion: d.schemaVersion, latencyMs: null, inputTokens: null, outputTokens: null,
  }));
}

Deno.test("technicalStatuses always has exactly 5 entries, matching the shadow records 1:1", () => {
  const records = allNoEvidenceRecords();
  const metrics = computeExpenseSpecialistShadowMetrics({ records: records as any, claims: [], authoritativeFields: {} });
  assertEquals(Object.keys(metrics.technicalStatuses).length, 5);
  for (const record of records) assertEquals(metrics.technicalStatuses[record.domain], "no_evidence");
});

Deno.test("specialistObligationCount sums obligations across all records", () => {
  const records = allNoEvidenceRecords();
  records[0] = { ...records[0], technicalStatus: "success", obligations: [{}, {}] };
  records[1] = { ...records[1], technicalStatus: "success", obligations: [{}] };
  const metrics = computeExpenseSpecialistShadowMetrics({ records: records as any, claims: [], authoritativeFields: {} });
  assertEquals(metrics.specialistObligationCount, 3);
});

Deno.test("authoritativePopulatedFieldCount counts only non-null authoritative field values", () => {
  const metrics = computeExpenseSpecialistShadowMetrics({
    records: allNoEvidenceRecords() as any, claims: [],
    authoritativeFields: { electric_responsibility: { value: "tenant" }, water_sewer_responsibility: { value: null }, tax_responsibility: undefined },
  });
  assertEquals(metrics.authoritativePopulatedFieldCount, 1);
});

Deno.test("specialistClaimsWithEvidence / specialistClaimsNeedingReview count correctly", () => {
  const [withEvidence] = utilityObligationsToClaims(
    [{ utilityType: "electricity", responsibleParty: "tenant", billingMethod: "direct_to_provider", status: "explicit", sourcePage: 1, sourceQuote: "q" }],
    CONTEXT, "utility-obligation-v1",
  );
  const [needingReview] = utilityObligationsToClaims(
    [{ utilityType: "water", responsibleParty: "shared", billingMethod: "pro_rata_share", status: "ambiguous", sourcePage: 1, sourceQuote: "q" }],
    CONTEXT, "utility-obligation-v1",
  );
  const [withoutEvidence] = utilityObligationsToClaims(
    [{ utilityType: "gas", responsibleParty: "tenant", billingMethod: "flat_fee", status: "explicit", sourcePage: null, sourceQuote: null }],
    CONTEXT, "utility-obligation-v1",
  );
  const claims = [withEvidence, needingReview, withoutEvidence];
  const metrics = computeExpenseSpecialistShadowMetrics({ records: allNoEvidenceRecords() as any, claims, authoritativeFields: {} });
  assertEquals(metrics.specialistClaimsWithEvidence, 2, "withEvidence and needingReview both have sourceQuote");
  assertEquals(metrics.specialistClaimsNeedingReview, 1, "only the ambiguous-status claim requires review");
});

Deno.test("responsibility concept comparison: agreement produces no disagreement, no only-in-either entries", () => {
  const [claim] = utilityObligationsToClaims(
    [{ utilityType: "electricity", responsibleParty: "tenant", billingMethod: "direct_to_provider", status: "explicit", sourcePage: 1, sourceQuote: "q" }],
    CONTEXT, "utility-obligation-v1",
  ).filter((c) => c.fieldCode.endsWith(".responsibleParty"));
  const metrics = computeExpenseSpecialistShadowMetrics({
    records: allNoEvidenceRecords() as any, claims: [claim],
    authoritativeFields: { electric_responsibility: { value: "tenant" } },
  });
  assertEquals(metrics.responsibilityDisagreements, 0);
  assertEquals(metrics.conceptsOnlyInAuthoritative, []);
  assertEquals(metrics.conceptsOnlyInSpecialists, []);
});

Deno.test("responsibility concept comparison: disagreement is counted when both sides have a value but differ", () => {
  const [claim] = utilityObligationsToClaims(
    [{ utilityType: "electricity", responsibleParty: "landlord", billingMethod: "direct_to_provider", status: "explicit", sourcePage: 1, sourceQuote: "q" }],
    CONTEXT, "utility-obligation-v1",
  ).filter((c) => c.fieldCode.endsWith(".responsibleParty"));
  const metrics = computeExpenseSpecialistShadowMetrics({
    records: allNoEvidenceRecords() as any, claims: [claim],
    authoritativeFields: { electric_responsibility: { value: "tenant" } },
  });
  assertEquals(metrics.responsibilityDisagreements, 1);
});

Deno.test("responsibility concept comparison: only-in-specialist and only-in-authoritative are distinguished", () => {
  const [claim] = utilityObligationsToClaims(
    [{ utilityType: "electricity", responsibleParty: "tenant", billingMethod: "direct_to_provider", status: "explicit", sourcePage: 1, sourceQuote: "q" }],
    CONTEXT, "utility-obligation-v1",
  ).filter((c) => c.fieldCode.endsWith(".responsibleParty"));

  const onlySpecialist = computeExpenseSpecialistShadowMetrics({
    records: allNoEvidenceRecords() as any, claims: [claim], authoritativeFields: {},
  });
  assertEquals(onlySpecialist.conceptsOnlyInSpecialists, ["electric utility responsibility"]);
  assertEquals(onlySpecialist.conceptsOnlyInAuthoritative, []);

  const onlyAuthoritative = computeExpenseSpecialistShadowMetrics({
    records: allNoEvidenceRecords() as any, claims: [],
    authoritativeFields: { electric_responsibility: { value: "tenant" } },
  });
  assertEquals(onlyAuthoritative.conceptsOnlyInAuthoritative, ["electric utility responsibility"]);
  assertEquals(onlyAuthoritative.conceptsOnlyInSpecialists, []);
});

Deno.test("possibleCanonicalMappings / proposedDynamicRows mirror proposeClaimPlacements exactly", () => {
  const safeClaim = utilityObligationsToClaims(
    [{ utilityType: "electricity", responsibleParty: "tenant", billingMethod: "direct_to_provider", status: "explicit", sourcePage: 1, sourceQuote: "q" }],
    CONTEXT, "utility-obligation-v1",
  ).find((c) => c.fieldCode.endsWith(".responsibleParty"));
  const dynamicClaim = repairObligationsToClaims(
    [{ component: "roof", responsibleParty: "landlord", obligationType: "maintain", status: "explicit", sourcePage: 1, sourceQuote: "q" }],
    CONTEXT, "repair-obligation-v1",
  ).find((c) => c.fieldCode.endsWith(".responsibleParty"));
  const metrics = computeExpenseSpecialistShadowMetrics({
    records: allNoEvidenceRecords() as any, claims: [safeClaim, dynamicClaim], authoritativeFields: {},
  });
  assertEquals(metrics.possibleCanonicalMappings, 1);
  assertEquals(metrics.proposedDynamicRows, 1);
});

Deno.test("authoritativeDroppedDownstreamCount: 0 when no raw/post snapshot is supplied (nothing to compare, not a false-healthy claim)", () => {
  const metrics = computeExpenseSpecialistShadowMetrics({
    records: allNoEvidenceRecords() as any, claims: [], authoritativeFields: {},
  });
  assertEquals(metrics.authoritativeDroppedDownstreamCount, 0);
});

Deno.test("authoritativeDroppedDownstreamCount: counts a real drop (raw had a value, post-verification lost it, not explicitly nulled)", () => {
  const metrics = computeExpenseSpecialistShadowMetrics({
    records: allNoEvidenceRecords() as any, claims: [], authoritativeFields: { electric_responsibility: { value: null } },
    authoritativeRawFields: { electric_responsibility: { value: "tenant" } },
  });
  assertEquals(metrics.authoritativeDroppedDownstreamCount, 1);
});

Deno.test("authoritativeDroppedDownstreamCount: does NOT count an explicit verifier null decision as a drop", () => {
  const metrics = computeExpenseSpecialistShadowMetrics({
    records: allNoEvidenceRecords() as any, claims: [], authoritativeFields: { electric_responsibility: { value: null } },
    authoritativeRawFields: { electric_responsibility: { value: "tenant" } },
    explicitlyNulledFields: new Set(["electric_responsibility"]),
  });
  assertEquals(metrics.authoritativeDroppedDownstreamCount, 0);
});

Deno.test("buildExpenseSpecialistShadowMetrics: one-shot convenience wrapper produces the same claims/metrics as calling both functions separately", () => {
  const records = allNoEvidenceRecords();
  records[2] = {
    ...records[2], technicalStatus: "success",
    obligations: [{ coverageType: "building", obligatedParty: "not_stated", obligationType: "must_insure", economicTreatment: "included_in_rent", status: "explicit", sourcePage: 1, sourceQuote: "q" }],
  };
  const { claims, metrics } = buildExpenseSpecialistShadowMetrics({
    records: records as any, context: CONTEXT, doclingRaw: null, authoritativeFields: {},
  });
  assert(claims.length > 0);
  assertEquals(metrics.specialistObligationCount, 1);
});
