// @ts-nocheck
// Release 2: unit tests for the projection-diff engine that compares legacy
// ui_review_payload fields against v3 document_canonical_field_projections
// rows. Pure logic, no DB -- see document-intelligence-v3-side-write.property.test.ts
// for the integration-level test that a real run actually produces rows.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  hasComparableValue,
  isAmbiguousDateFormat,
  compareFieldValues,
  classifyMateriality,
  buildProjectionDiff,
  summarizeProjectionDiff,
  CRITICAL_FIELD_KEYS,
} from "../_shared/extraction/document-intelligence-v3/projection-diff.ts";
import { getSchema } from "../_shared/extraction/schemas.ts";

const leaseSchema = getSchema("lease");

// ── hasComparableValue() ─────────────────────────────────────────────────

Deno.test("hasComparableValue: 0 is present, not treated as absent", () => {
  assertEquals(hasComparableValue(0), true);
});

Deno.test("hasComparableValue: false is present, not treated as absent", () => {
  assertEquals(hasComparableValue(false), true);
});

Deno.test("hasComparableValue: empty string, null, undefined are absent", () => {
  assertEquals(hasComparableValue(""), false);
  assertEquals(hasComparableValue("   "), false);
  assertEquals(hasComparableValue(null), false);
  assertEquals(hasComparableValue(undefined), false);
});

Deno.test("hasComparableValue: a normal string/number is present", () => {
  assertEquals(hasComparableValue("Acme Inc"), true);
  assertEquals(hasComparableValue(5), true);
});

// ── isAmbiguousDateFormat() ───────────────────────────────────────────────

Deno.test("isAmbiguousDateFormat: MM/DD-or-DD/MM slash date with both components <=12 is ambiguous", () => {
  assertEquals(isAmbiguousDateFormat("01/02/2026"), true);
});

Deno.test("isAmbiguousDateFormat: a slash date with a component >12 is unambiguous", () => {
  assertEquals(isAmbiguousDateFormat("13/02/2026"), false);
  assertEquals(isAmbiguousDateFormat("02/13/2026"), false);
});

Deno.test("isAmbiguousDateFormat: ISO and named-month forms are never ambiguous", () => {
  assertEquals(isAmbiguousDateFormat("2026-01-02"), false);
  assertEquals(isAmbiguousDateFormat("July 1, 2026"), false);
});

// ── compareFieldValues(): normalization per type ─────────────────────────

Deno.test("compareFieldValues: date -- 'July 1, 2026' normalized-matches '2026-07-01'", () => {
  const field = leaseSchema.commencement_date;
  const result = compareFieldValues("July 1, 2026", "2026-07-01", field, "commencement_date");
  assertEquals(result.valueMatch, true);
  assertEquals(result.differenceType, "normalized_match");
  assertEquals(result.dateAmbiguous, false);
});

Deno.test("compareFieldValues: currency -- '$1,250.00' normalized-matches 1250", () => {
  const field = leaseSchema.monthly_rent;
  const result = compareFieldValues("$1,250.00", 1250, field, "monthly_rent");
  assertEquals(result.valueMatch, true);
  assertEquals(result.differenceType, "normalized_match");
});

Deno.test("compareFieldValues: percent -- this platform's convention is the raw percent number, '5%' matches 5, NOT 0.05", () => {
  const field = leaseSchema.admin_fee_pct;
  const matches5 = compareFieldValues("5%", 5, field, "admin_fee_pct");
  assertEquals(matches5.valueMatch, true, "5% should match 5 under this platform's percent convention");
  const doesNotMatchDecimalFraction = compareFieldValues("5%", 0.05, field, "admin_fee_pct");
  assertEquals(doesNotMatchDecimalFraction.valueMatch, false, "5% should NOT match 0.05 -- that is not this platform's stored convention");
});

Deno.test("compareFieldValues: ambiguous slash date is flagged but still produces a best-effort normalized match", () => {
  const field = leaseSchema.commencement_date;
  const result = compareFieldValues("01/02/2026", "2026-01-02", field, "commencement_date");
  assertEquals(result.dateAmbiguous, true);
  assertEquals(result.valueMatch, true); // MM/DD/YYYY assumption still applied consistently
});

Deno.test("compareFieldValues: unambiguous date raw match sets dateAmbiguous=false even for a slash form", () => {
  const field = leaseSchema.commencement_date;
  // Identical raw strings never need normalization -- no ambiguity concern.
  const result = compareFieldValues("2026-01-02", "2026-01-02", field, "commencement_date");
  assertEquals(result.dateAmbiguous, false);
  assertEquals(result.differenceType, "exact_match");
});

Deno.test("compareFieldValues: legacy_only when canonical side has no value", () => {
  const field = leaseSchema.tenant_name;
  const result = compareFieldValues("Acme Inc", null, field, "tenant_name");
  assertEquals(result.differenceType, "legacy_only");
  assertEquals(result.valueMatch, false);
});

Deno.test("compareFieldValues: canonical_only when legacy side has no value", () => {
  const field = leaseSchema.tenant_name;
  const result = compareFieldValues(null, "Acme Inc", field, "tenant_name");
  assertEquals(result.differenceType, "canonical_only");
  assertEquals(result.valueMatch, false);
});

Deno.test("compareFieldValues: both absent is an exact_match (nothing to disagree about)", () => {
  const field = leaseSchema.tenant_name;
  const result = compareFieldValues(null, null, field, "tenant_name");
  assertEquals(result.differenceType, "exact_match");
  assertEquals(result.valueMatch, true);
});

Deno.test("compareFieldValues: enum synonym match via case/whitespace normalization against enumValues", () => {
  const field = leaseSchema.responsibility_taxes; // enum: landlord/tenant/shared/landlord_with_cap
  const result = compareFieldValues("Tenant", " tenant ", field, "responsibility_taxes");
  assertEquals(result.valueMatch, true);
});

Deno.test("compareFieldValues: enum value conflict when the two sides resolve to different canonical enum values", () => {
  const field = leaseSchema.responsibility_taxes;
  const result = compareFieldValues("landlord", "tenant", field, "responsibility_taxes");
  assertEquals(result.valueMatch, false);
  assertEquals(result.differenceType, "value_conflict");
});

Deno.test("compareFieldValues: genuine value conflict on a critical field", () => {
  const field = leaseSchema.monthly_rent;
  const result = compareFieldValues(5000, 6000, field, "monthly_rent");
  assertEquals(result.valueMatch, false);
  assertEquals(result.differenceType, "value_conflict");
});

// ── classifyMateriality() ─────────────────────────────────────────────────

Deno.test("classifyMateriality: value_conflict on a critical field is critical", () => {
  const field = leaseSchema.admin_fee_pct;
  assertEquals(classifyMateriality("admin_fee_pct", "value_conflict", field), "critical");
});

Deno.test("classifyMateriality: value_conflict on a non-critical enforced field is material, not critical", () => {
  const field = leaseSchema.late_fee_amount; // enforced, not in CRITICAL_FIELD_KEYS
  assert(!CRITICAL_FIELD_KEYS.includes("late_fee_amount"));
  assertEquals(classifyMateriality("late_fee_amount", "value_conflict", field), "material");
});

Deno.test("classifyMateriality: exact/normalized matches are always informational", () => {
  const field = leaseSchema.admin_fee_pct;
  assertEquals(classifyMateriality("admin_fee_pct", "exact_match", field), "informational");
  assertEquals(classifyMateriality("admin_fee_pct", "normalized_match", field), "informational");
});

Deno.test("classifyMateriality: evidence_conflict alone is always informational, even on a critical field (review correction 4)", () => {
  const field = leaseSchema.monthly_rent;
  assertEquals(classifyMateriality("monthly_rent", "evidence_conflict", field), "informational");
});

// ── buildProjectionDiff() / summarizeProjectionDiff(): comparison_status gating ──

Deno.test("buildProjectionDiff: zero canonical projections + no claims -> unavailable_no_fact_ledger, not a fabricated 0% agreement", () => {
  const { diffs, comparisonStatus } = buildProjectionDiff({
    documentId: "doc-1",
    legacyFields: [{ field_key: "tenant_name", value: "Acme Inc" }],
    canonicalProjections: [],
    hasClaims: false,
    moduleType: "lease",
  });
  assertEquals(comparisonStatus, "unavailable_no_fact_ledger");
  assertEquals(diffs.length, 0);
  const summary = summarizeProjectionDiff(diffs, comparisonStatus);
  assertEquals(summary.exactMatchRate, null);
  assertEquals(summary.normalizedMatchRate, null);
  assertEquals(summary.criticalFieldAgreementRate, null);
});

Deno.test("buildProjectionDiff: zero canonical projections but claims existed -> unavailable_no_projections (a real gap, distinct from Mode A)", () => {
  const { comparisonStatus } = buildProjectionDiff({
    documentId: "doc-1",
    legacyFields: [{ field_key: "tenant_name", value: "Acme Inc" }],
    canonicalProjections: [],
    hasClaims: true,
    moduleType: "lease",
  });
  assertEquals(comparisonStatus, "unavailable_no_projections");
});

Deno.test("buildProjectionDiff: available comparison produces real diffs and a non-null summary", () => {
  const { diffs, comparisonStatus } = buildProjectionDiff({
    documentId: "doc-1",
    legacyFields: [
      { field_key: "tenant_name", value: "Acme Inc", status: "auto_populated", confidence: 96, evidence: { source_page: 1 } },
      { field_key: "admin_fee_pct", value: 5, status: "auto_populated", confidence: 90, evidence: { source_page: 4 } },
    ],
    canonicalProjections: [
      { field_key: "tenant_name", value: "Acme Inc", status: "auto_populated", confidence: 96, source_page: 1 },
      { field_key: "admin_fee_pct", value: 12, status: "needs_review", confidence: 60, source_page: 9 },
    ],
    hasClaims: true,
    moduleType: "lease",
  });
  assertEquals(comparisonStatus, "available");
  assertEquals(diffs.length, 2);

  const adminFeeDiff = diffs.find((d) => d.fieldKey === "admin_fee_pct");
  assertEquals(adminFeeDiff.differenceType, "value_conflict");
  assertEquals(adminFeeDiff.materiality, "critical");
  assertEquals(adminFeeDiff.evidencePageMatch, false);

  const summary = summarizeProjectionDiff(diffs, comparisonStatus);
  assertEquals(summary.fieldCount, 2);
  assert(summary.exactMatchRate !== null);
  assertEquals(summary.materialConflictCount, 1);
  assertEquals(summary.criticalFieldAgreementRate, 0.5); // tenant_name agrees, admin_fee_pct doesn't
});

Deno.test("buildProjectionDiff: evidence-page-only mismatch with matching values does not count as a material conflict", () => {
  const { diffs, comparisonStatus } = buildProjectionDiff({
    documentId: "doc-1",
    legacyFields: [{ field_key: "monthly_rent", value: 5000, evidence: { source_page: 3 } }],
    canonicalProjections: [{ field_key: "monthly_rent", value: 5000, source_page: 11 }],
    hasClaims: true,
    moduleType: "lease",
  });
  assertEquals(comparisonStatus, "available");
  const diff = diffs[0];
  assertEquals(diff.valueMatch, true);
  assertEquals(diff.evidencePageMatch, false);
  assertEquals(diff.differenceType, "evidence_conflict");
  assertEquals(diff.materiality, "informational");
  const summary = summarizeProjectionDiff(diffs, comparisonStatus);
  assertEquals(summary.materialConflictCount, 0);
  assertEquals(summary.evidencePageMismatchCount, 1);
});

Deno.test("buildProjectionDiff: status-only mismatch with matching values surfaces as status_conflict, not value_conflict", () => {
  const { diffs } = buildProjectionDiff({
    documentId: "doc-1",
    legacyFields: [{ field_key: "tenant_name", value: "Acme Inc", status: "needs_review", evidence: { source_page: 1 } }],
    canonicalProjections: [{ field_key: "tenant_name", value: "Acme Inc", status: "reviewer_confirmed", source_page: 1 }],
    hasClaims: true,
    moduleType: "lease",
  });
  const diff = diffs[0];
  assertEquals(diff.valueMatch, true);
  assertEquals(diff.statusMatch, false);
  assertEquals(diff.differenceType, "status_conflict");
});

Deno.test("buildProjectionDiff: rejected-candidates audit trail unaffected -- legacy-only field on a critical key is critical materiality", () => {
  const { diffs } = buildProjectionDiff({
    documentId: "doc-1",
    legacyFields: [{ field_key: "expiration_date", value: "2030-12-31" }],
    canonicalProjections: [{ field_key: "tenant_name", value: "Acme Inc" }], // unrelated field, forces non-empty canonicalProjections
    hasClaims: true,
    moduleType: "lease",
  });
  const diff = diffs.find((d) => d.fieldKey === "expiration_date");
  assertEquals(diff.differenceType, "legacy_only");
  assertEquals(diff.materiality, "critical");
});
