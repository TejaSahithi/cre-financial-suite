// @ts-nocheck
// Phase 6A deduplication tests (expense-obligation-dedup.ts, correction B —
// the most important fix from the review pass). Subject identity vs value
// fingerprint MUST be separate concepts, or a genuine responsibility
// conflict (same subject, disagreeing value) would land in different
// groups and never even be compared.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { dedupeExpenseObligations, obligationSubjectKey, obligationValueFingerprint } from "../_shared/extraction/canonical/financial/expense-obligation-dedup.ts";
import { taxSpecialistToExpenseObligations, insuranceSpecialistToExpenseObligations, camSpecialistToExpenseObligations } from "../_shared/extraction/canonical/financial/expense-obligation-converters.ts";

const CONTEXT = { organizationId: "org-1", fileId: "file-1", generationId: "gen-1", extractionRunId: "run-1" };

function taxObligation(overrides: Record<string, unknown> = {}) {
  return taxSpecialistToExpenseObligations(
    [{ category: "real_estate_tax", responsibleParty: "tenant", economicTreatment: "direct_cost", baseYear: null, capOrLimit: null, status: "explicit", sourcePage: 1, sourceQuote: "q1", ...overrides }],
    CONTEXT, "tax-obligation-v1",
  )[0];
}

// ── Correction B: conflict is only detectable via subject/fingerprint split ─

Deno.test("obligationSubjectKey: identical for two obligations with the same category/subcategory/obligationType/period regardless of responsibleParty", () => {
  const tenantVersion = taxObligation({ responsibleParty: "tenant" });
  const landlordVersion = taxObligation({ responsibleParty: "landlord" });
  assertEquals(obligationSubjectKey(tenantVersion), obligationSubjectKey(landlordVersion), "same real-world subject must share a subject key even when the claimed value disagrees");
});

Deno.test("obligationValueFingerprint: differs when responsibleParty differs", () => {
  const tenantVersion = taxObligation({ responsibleParty: "tenant" });
  const landlordVersion = taxObligation({ responsibleParty: "landlord" });
  assert(obligationValueFingerprint(tenantVersion) !== obligationValueFingerprint(landlordVersion));
});

Deno.test("dedupeExpenseObligations: conflicting responsibility (tax: tenant vs tax: landlord) reaches exactly ONE conflict group, both obligations kept and flagged", () => {
  const tenantVersion = taxObligation({ responsibleParty: "tenant", sourceQuote: "Tenant shall pay real estate taxes." });
  const landlordVersion = taxObligation({ responsibleParty: "landlord", sourceQuote: "Landlord shall pay real estate taxes." });
  const result = dedupeExpenseObligations([tenantVersion, landlordVersion]);
  assertEquals(result.deduped.length, 2, "both conflicting obligations must be preserved, never silently dropped");
  assertEquals(result.conflictingObligations, 1, "exactly one conflict GROUP, not one per obligation");
  assert(result.deduped.every((o) => o.status === "conflicting"));
  assert(result.deduped.every((o) => o.requiresReview === true));
});

Deno.test("dedupeExpenseObligations: same category, genuinely different obligations (different obligationType) are preserved independently, never merged or flagged conflicting", () => {
  const managementFee = camSpecialistToExpenseObligations(
    [{ category: "management_fee", responsibleParty: "tenant", paymentMechanism: "additional_rent", allocationMethod: "not_stated", amountType: "percentage", amount: null, percentage: 3, cap: null, inclusions: [], exclusions: [], reconciliationFrequency: null, auditRight: null, status: "explicit", sourcePage: 1, sourceQuote: "mgmt fee" }],
    CONTEXT, "cam-obligation-v1",
  )[0];
  const cam = camSpecialistToExpenseObligations(
    [{ category: "common_area_maintenance", responsibleParty: "tenant", paymentMechanism: "additional_rent", allocationMethod: "pro_rata_share", amountType: "included", amount: null, percentage: null, cap: null, inclusions: [], exclusions: [], reconciliationFrequency: null, auditRight: null, status: "explicit", sourcePage: 1, sourceQuote: "cam clause" }],
    CONTEXT, "cam-obligation-v1",
  )[0];
  const result = dedupeExpenseObligations([managementFee, cam]);
  assertEquals(result.deduped.length, 2);
  assertEquals(result.conflictingObligations, 0);
  assert(result.deduped.every((o) => o.status !== "conflicting"));
});

Deno.test("dedupeExpenseObligations: different insurance subjects (tenant-property insurance -> tenant vs building insurance -> landlord) stay independent, not compared for conflict at all", () => {
  const tenantProperty = insuranceSpecialistToExpenseObligations(
    [{ coverageType: "tenant_property", obligatedParty: "tenant", obligationType: "must_insure", economicTreatment: "direct_cost", status: "explicit", sourcePage: 1, sourceQuote: "tenant property insurance" }],
    CONTEXT, "insurance-obligation-v1",
  )[0];
  const building = insuranceSpecialistToExpenseObligations(
    [{ coverageType: "building", obligatedParty: "landlord", obligationType: "must_insure", economicTreatment: "direct_cost", status: "explicit", sourcePage: 1, sourceQuote: "building insurance" }],
    CONTEXT, "insurance-obligation-v1",
  )[0];
  assert(obligationSubjectKey(tenantProperty) !== obligationSubjectKey(building), "different categories (tenant_property_insurance vs property_insurance) must be different subjects");
  const result = dedupeExpenseObligations([tenantProperty, building]);
  assertEquals(result.deduped.length, 2);
  assertEquals(result.conflictingObligations, 0);
});

// ── Exact duplicate / corroboration ──────────────────────────────────────────

Deno.test("dedupeExpenseObligations: same subject + same value + same evidence -> exact duplicate, collapsed to one", () => {
  const a = taxObligation({ sourceQuote: "Tenant shall pay real estate taxes.", sourcePage: 1 });
  const b = taxObligation({ sourceQuote: "Tenant shall pay real estate taxes.", sourcePage: 1 });
  const result = dedupeExpenseObligations([a, b]);
  assertEquals(result.deduped.length, 1);
  assertEquals(result.duplicateObligationsCollapsed, 1);
  assertEquals(result.corroboratingEvidenceMerged, 0);
});

Deno.test("dedupeExpenseObligations: same subject + same value + DIFFERENT evidence -> merge evidence into one corroborated obligation", () => {
  const a = taxObligation({ sourceQuote: "Tenant shall pay real estate taxes.", sourcePage: 1 });
  const b = taxObligation({ sourceQuote: "Section 12.1 confirms Tenant pays all real estate taxes.", sourcePage: 4 });
  const result = dedupeExpenseObligations([a, b]);
  assertEquals(result.deduped.length, 1);
  assertEquals(result.corroboratingEvidenceMerged, 1);
  assertEquals(result.deduped[0].evidence.length, 2, "both evidence entries should be preserved on the merged obligation");
  assert(result.deduped[0].evidence.some((e) => e.role === "corroborating"));
});

Deno.test("dedupeExpenseObligations: a single obligation with no siblings passes through unchanged", () => {
  const a = taxObligation();
  const result = dedupeExpenseObligations([a]);
  assertEquals(result.deduped.length, 1);
  assertEquals(result.duplicateObligationsCollapsed, 0);
  assertEquals(result.corroboratingEvidenceMerged, 0);
  assertEquals(result.conflictingObligations, 0);
});
