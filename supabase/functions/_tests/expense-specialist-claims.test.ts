// @ts-nocheck
// Phase 5 obligation -> canonical claim conversion (canonical/expense-specialist-claims.ts).
// This file covers converter mechanics (fieldCode shape, shared evidence,
// status mapping, mapping-policy routing) with small synthetic obligation
// objects; the narrative clause fixtures (insurance-inclusion negative
// case, multi-utility distinctness, CAM cap) live in
// expense-specialist-fixtures.test.ts (Phase 5.7).

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  camObligationsToClaims,
  taxObligationsToClaims,
  insuranceObligationsToClaims,
  utilityObligationsToClaims,
  repairObligationsToClaims,
  expenseSpecialistRecordsToClaims,
  safeExactCanonicalMappingExists,
  proposeCanonicalMapping,
  proposeDynamicRow,
  proposeClaimPlacements,
} from "../_shared/extraction/canonical/expense-specialist-claims.ts";

const CONTEXT = { organizationId: "org-1", fileId: "file-1", generationId: "gen-1", extractionRunId: "run-1" };

// ── fieldCode shape / shared evidence / status mapping ──────────────────────

Deno.test("utilityObligationsToClaims: fieldCode includes the disambiguating utilityType segment", () => {
  const claims = utilityObligationsToClaims(
    [{ utilityType: "electricity", responsibleParty: "tenant", billingMethod: "direct_to_provider", status: "explicit", sourcePage: 3, sourceQuote: "Tenant shall pay for electricity." }],
    CONTEXT, "utility-obligation-v1",
  );
  const fieldCodes = claims.map((c) => c.fieldCode);
  assert(fieldCodes.includes("expense.utility.electricity.responsibleParty"));
  assert(fieldCodes.includes("expense.utility.electricity.billingMethod"));
});

Deno.test("utilityObligationsToClaims: two different utility types never collide on fieldCode", () => {
  const claims = utilityObligationsToClaims(
    [
      { utilityType: "electricity", responsibleParty: "tenant", billingMethod: "direct_to_provider", status: "explicit", sourcePage: 1, sourceQuote: "electricity clause" },
      { utilityType: "water", responsibleParty: "landlord", billingMethod: "included_in_rent", status: "explicit", sourcePage: 1, sourceQuote: "water clause" },
    ],
    CONTEXT, "utility-obligation-v1",
  );
  const fieldCodes = new Set(claims.map((c) => c.fieldCode));
  assertEquals(fieldCodes.size, claims.length, "no two claims from different utility types should share a fieldCode");
  const electricityResp = claims.find((c) => c.fieldCode === "expense.utility.electricity.responsibleParty");
  const waterResp = claims.find((c) => c.fieldCode === "expense.utility.water.responsibleParty");
  assertEquals(electricityResp.normalizedValue, "tenant");
  assertEquals(waterResp.normalizedValue, "landlord");
});

Deno.test("all sub-claims of one obligation instance share that instance's single evidence pair", () => {
  const claims = repairObligationsToClaims(
    [{ component: "roof", responsibleParty: "landlord", obligationType: "maintain", status: "explicit", sourcePage: 7, sourceQuote: "Landlord shall maintain the roof." }],
    CONTEXT, "repair-obligation-v1",
  );
  assertEquals(claims.length, 2); // responsibleParty + obligationType
  for (const claim of claims) {
    assertEquals(claim.evidence.length, 1);
    assertEquals(claim.evidence[0].quote, "Landlord shall maintain the roof.");
    assertEquals(claim.evidence[0].pageNumber, 7);
  }
});

Deno.test("obligation.status maps directly onto claim.status, requiresReview true for ambiguous/conflicting", () => {
  const [explicitClaim] = taxObligationsToClaims(
    [{ category: "real_estate_tax", responsibleParty: "tenant", economicTreatment: "direct_cost", baseYear: null, capOrLimit: null, status: "explicit", sourcePage: 1, sourceQuote: "q" }],
    CONTEXT, "tax-obligation-v1",
  );
  assertEquals(explicitClaim.status, "explicit");
  assertEquals(explicitClaim.requiresReview, false);

  const [ambiguousClaim] = taxObligationsToClaims(
    [{ category: "real_estate_tax", responsibleParty: "tenant", economicTreatment: "direct_cost", baseYear: null, capOrLimit: null, status: "ambiguous", sourcePage: 1, sourceQuote: "q" }],
    CONTEXT, "tax-obligation-v1",
  );
  assertEquals(ambiguousClaim.status, "ambiguous");
  assertEquals(ambiguousClaim.requiresReview, true);
});

Deno.test("camObligationsToClaims: cap (a nested object) becomes its own claim, normalizedValue is the whole object", () => {
  const claims = camObligationsToClaims(
    [{
      category: "common_area_maintenance", responsibleParty: "tenant", paymentMechanism: "additional_rent",
      allocationMethod: "pro_rata_share", amountType: "percentage", amount: null, percentage: null,
      cap: { type: "cumulative_percentage", value: 5, appliesTo: "controllable expenses" },
      inclusions: [], exclusions: [], reconciliationFrequency: "annual", auditRight: null,
      status: "explicit", sourcePage: 2, sourceQuote: "controllable expenses shall not increase by more than 5% cumulatively",
    }],
    CONTEXT, "cam-obligation-v1",
  );
  const capClaim = claims.find((c) => c.fieldCode === "expense.cam.common_area_maintenance.cap");
  assert(capClaim, "expected a cap claim");
  assertEquals(capClaim.normalizedValue, { type: "cumulative_percentage", value: 5, appliesTo: "controllable expenses" });
});

Deno.test("expenseSpecialistRecordsToClaims: only 'success' records contribute claims, others contribute zero", () => {
  const records = [
    { domain: "insurance", technicalStatus: "no_evidence", obligations: [], errorMessage: null, schemaVersion: "insurance-obligation-v1", latencyMs: null, inputTokens: null, outputTokens: null },
    {
      domain: "utilities", technicalStatus: "success",
      obligations: [{ utilityType: "gas", responsibleParty: "tenant", billingMethod: "direct_to_provider", status: "explicit", sourcePage: 1, sourceQuote: "q" }],
      errorMessage: null, schemaVersion: "utility-obligation-v1", latencyMs: 100, inputTokens: 10, outputTokens: 5,
    },
  ];
  const claims = expenseSpecialistRecordsToClaims(records as any, CONTEXT, null);
  assert(claims.length > 0);
  assert(claims.every((c) => c.domain === "utilities"), "the no_evidence insurance record must contribute zero claims");
});

// ── mapping policy: safe exact canonical mapping vs dynamic row ─────────────

Deno.test("safeExactCanonicalMappingExists: true for electricity responsibleParty=tenant, maps to electric_responsibility", () => {
  const [claim] = utilityObligationsToClaims(
    [{ utilityType: "electricity", responsibleParty: "tenant", billingMethod: "direct_to_provider", status: "explicit", sourcePage: 1, sourceQuote: "q" }],
    CONTEXT, "utility-obligation-v1",
  );
  const respClaim = claim.fieldCode.endsWith(".responsibleParty") ? claim : null;
  assert(respClaim);
  assert(safeExactCanonicalMappingExists(respClaim));
  const mapping = proposeCanonicalMapping(respClaim);
  assertEquals(mapping.targetFieldKey, "electric_responsibility");
  assertEquals(mapping.value, "tenant");
});

Deno.test("safeExactCanonicalMappingExists: false for 'conditional'/'mixed' responsibleParty -- not force-fit into the legacy 3-value field", () => {
  const claims = utilityObligationsToClaims(
    [{ utilityType: "electricity", responsibleParty: "conditional", billingMethod: "direct_to_provider", status: "explicit", sourcePage: 1, sourceQuote: "q" }],
    CONTEXT, "utility-obligation-v1",
  );
  const respClaim = claims.find((c) => c.fieldCode.endsWith(".responsibleParty"));
  assertEquals(safeExactCanonicalMappingExists(respClaim), false);
  assertEquals(proposeCanonicalMapping(respClaim), null);
});

Deno.test("safeExactCanonicalMappingExists: false for CAM cap (vocabulary mismatch) and for repair claims (granularity loss) -- always dynamic row", () => {
  const [capClaim] = camObligationsToClaims(
    [{ category: "common_area_maintenance", responsibleParty: "tenant", paymentMechanism: "additional_rent", allocationMethod: "pro_rata_share", amountType: "percentage", amount: null, percentage: null, cap: { type: "cumulative_percentage", value: 5, appliesTo: null }, inclusions: [], exclusions: [], reconciliationFrequency: null, auditRight: null, status: "explicit", sourcePage: 1, sourceQuote: "q" }],
    CONTEXT, "cam-obligation-v1",
  ).filter((c) => c.fieldCode.endsWith(".cap"));
  assertEquals(safeExactCanonicalMappingExists(capClaim), false);

  const [repairClaim] = repairObligationsToClaims(
    [{ component: "roof", responsibleParty: "landlord", obligationType: "maintain", status: "explicit", sourcePage: 1, sourceQuote: "q" }],
    CONTEXT, "repair-obligation-v1",
  ).filter((c) => c.fieldCode.endsWith(".responsibleParty"));
  assertEquals(safeExactCanonicalMappingExists(repairClaim), false, "repairs must always be dynamic-row, never collapsed into one flat field");
});

Deno.test("proposeDynamicRow: carries sourceClaimIds, businessTab derived from domain", () => {
  const [claim] = repairObligationsToClaims(
    [{ component: "roof", responsibleParty: "landlord", obligationType: "maintain", status: "explicit", sourcePage: 4, sourceQuote: "Landlord shall maintain the roof." }],
    CONTEXT, "repair-obligation-v1",
  ).filter((c) => c.fieldCode.endsWith(".responsibleParty"));
  const row = proposeDynamicRow(claim);
  assertEquals(row.businessTab, "repairs_maintenance");
  assertEquals(row.value, "landlord");
  assertEquals(row.sourceClaimIds, [claim.claimId]);
  assertEquals(row.sourcePage, 4);
  assertEquals(row.sourceQuote, "Landlord shall maintain the roof.");
});

Deno.test("proposeClaimPlacements: partitions claims correctly between canonicalMappings and dynamicRows", () => {
  const safeClaims = utilityObligationsToClaims(
    [{ utilityType: "electricity", responsibleParty: "tenant", billingMethod: "direct_to_provider", status: "explicit", sourcePage: 1, sourceQuote: "q" }],
    CONTEXT, "utility-obligation-v1",
  );
  const unsafeClaims = repairObligationsToClaims(
    [{ component: "roof", responsibleParty: "landlord", obligationType: "maintain", status: "explicit", sourcePage: 1, sourceQuote: "q" }],
    CONTEXT, "repair-obligation-v1",
  );
  const { canonicalMappings, dynamicRows } = proposeClaimPlacements([...safeClaims, ...unsafeClaims]);
  assert(canonicalMappings.some((m) => m.targetFieldKey === "electric_responsibility"));
  assert(dynamicRows.some((r) => r.label.startsWith("repair.roof.")));
});
