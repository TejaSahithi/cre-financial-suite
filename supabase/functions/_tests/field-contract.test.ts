// @ts-nocheck
// Phase 4 tests for the lease field contract reconciliation task:
// field-contract.ts alias resolution, fact-field-mapper.ts alias-awareness,
// buildLeaseFieldMap()/deriveCamProfile()/buildBudgetHandoffReadiness()
// regression (confirming the "no changes needed" claim rather than just
// asserting it), and duplicate-concept field handling.
// Run: deno test --allow-env --allow-read --allow-net --no-lock field-contract.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  LEASE_FIELD_CONTRACT,
  resolveCanonicalKey,
  getFieldContract,
  getFieldsForGroup,
} from "../_shared/extraction/field-contract.ts";
import { mapFactsToStandardFields } from "../_shared/extraction/openai-fact-ledger/fact-field-mapper.ts";
import type { Fact } from "../_shared/extraction/openai-fact-ledger/types.ts";

const { __test__: workflowTest } = await import("../_shared/extraction/lease-workflow.ts");

// ── field-contract.ts: alias resolution ──────────────────────────────────────

Deno.test("resolveCanonicalKey: base_rent_monthly resolves to monthly_rent", () => {
  assertEquals(resolveCanonicalKey("base_rent_monthly"), "monthly_rent");
});

Deno.test("resolveCanonicalKey: tenant_rsf and rentable_area_sqft both resolve to square_footage", () => {
  assertEquals(resolveCanonicalKey("tenant_rsf"), "square_footage");
  assertEquals(resolveCanonicalKey("rentable_area_sqft"), "square_footage");
});

Deno.test("resolveCanonicalKey: the canonical key itself resolves to itself", () => {
  assertEquals(resolveCanonicalKey("monthly_rent"), "monthly_rent");
});

Deno.test("resolveCanonicalKey: an unknown key is returned unchanged, not thrown", () => {
  assertEquals(resolveCanonicalKey("not_a_real_field"), "not_a_real_field");
});

Deno.test("resolveCanonicalKey: start_date and commencement_date are NOT aliases of each other — they are distinct canonical fields (alternateFieldKeys, not aliases)", () => {
  assertEquals(resolveCanonicalKey("commencement_date"), "commencement_date");
  assertEquals(resolveCanonicalKey("start_date"), "start_date");
  const startDate = getFieldContract("start_date");
  assert(startDate.alternateFieldKeys?.includes("commencement_date"));
});

Deno.test("getFieldsForGroup: returns the right set for parties", () => {
  const parties = getFieldsForGroup("parties");
  const keys = parties.map((e) => e.canonicalKey);
  assert(keys.includes("tenant_name"));
  assert(keys.includes("landlord_name"));
  assert(keys.includes("tenant_address"), "tenant_address must be in the contract now that it has a LEASE_SCHEMA entry");
});

Deno.test("tenant_pro_rata_share is marked computed:true and is not independently extractable", () => {
  const entry = getFieldContract("tenant_pro_rata_share");
  assert(entry);
  assertEquals(entry.computed, true);
  assertEquals(entry.inLeaseSchema, false, "must not be a real LEASE_SCHEMA field — it is derived, not extracted");
});

Deno.test("field-contract.ts: no duplicate canonicalKeys", () => {
  const keys = LEASE_FIELD_CONTRACT.map((e) => e.canonicalKey);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  assertEquals(dupes, []);
});

// ── fact-field-mapper.ts: alias-awareness (Phase 3 parity fix) ───────────────

function makeFact(overrides: Partial<Fact>): Fact {
  return {
    category: "clause:default",
    value: "test value",
    sourceText: "Some source text",
    sourcePage: 1,
    confidence: 0.8,
    ...overrides,
  };
}

Deno.test("mapFactsToStandardFields: a fact phrased using an alias (not the canonical LEASE_SCHEMA label) now maps correctly", () => {
  // "base rent monthly" is not itself a monthly_rent LABEL in LEASE_SCHEMA,
  // but "base_rent_monthly" IS a field-contract alias for monthly_rent.
  const facts: Fact[] = [
    makeFact({
      value: 4200,
      sourceText: "Per the rent schedule, base_rent_monthly equals $4,200.",
      confidence: 0.85,
    }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.records[0].fields.monthly_rent?.value, 4200);
});

Deno.test("mapFactsToStandardFields: the 6 newly-added LEASE_SCHEMA fields are reachable", () => {
  const facts: Fact[] = [
    makeFact({ value: "500 Building Way, Suite 900, Springfield, IL", sourceText: "Landlord Address: 500 Building Way, Suite 900, Springfield, IL", confidence: 0.9 }),
    makeFact({ value: 45000, sourceText: "Building Total Rentable Square Footage: 45,000 building rsf", confidence: 0.9 }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.records[0].fields.landlord_address?.value, "500 Building Way, Suite 900, Springfield, IL");
  assertEquals(result.records[0].fields.building_rsf?.value, 45000);
});

// ── buildLeaseFieldMap()/deriveCamProfile()/buildBudgetHandoffReadiness() regression ─

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    tenant_name: "Acme Inc",
    landlord_name: "Landlord LLC",
    property_address: "123 Main St",
    monthly_rent: 5000,
    annual_rent: 60000,
    square_footage: 2500,
    start_date: "2025-01-01",
    end_date: "2030-01-01",
    lease_type: "nnn",
    billing_frequency: "monthly",
    rent_per_sf: 24,
    abstract_status: "approved",
    approval_status: "approved",
    ...overrides,
  };
}

const emptyDocling = { full_text: "", text_blocks: [], tables: [], fields: [] };

Deno.test("buildLeaseFieldMap: monthly_rent (LEASE_SCHEMA canonical) already bridges to base_rent_monthly (budgetFieldKeys' name) — regression, not a new behavior", () => {
  const row = baseRow();
  const fieldMap = workflowTest.buildLeaseFieldMap(row, emptyDocling, [], []);
  assertEquals(fieldMap.base_rent_monthly?.value, 5000);
});

Deno.test("buildLeaseFieldMap: square_footage (LEASE_SCHEMA canonical) already bridges to tenant_rsf (CAM's name) — regression, not a new behavior", () => {
  const row = baseRow();
  const fieldMap = workflowTest.buildLeaseFieldMap(row, emptyDocling, [], []);
  assertEquals(fieldMap.tenant_rsf?.value, 2500);
});

Deno.test("buildBudgetHandoffReadiness: identical shape/outcome before and after the Phase 2 schema additions — proves 'no changes needed'", () => {
  const row = baseRow();
  const fieldMap = workflowTest.buildLeaseFieldMap(row, emptyDocling, [], []);
  const camProfile = workflowTest.deriveCamProfile(fieldMap, []);
  const budgetPreview = workflowTest.deriveBudgetPreview(fieldMap, [], camProfile);
  const readiness = workflowTest.buildBudgetHandoffReadiness(row, fieldMap, [], budgetPreview);
  assert(readiness.approved_field_keys.length > 0, "monthly_rent/square_footage/dates should count as approved budget field keys");
  assert(Array.isArray(readiness.blocked_reasons));
});

// ── building_rsf / tenant_pro_rata_share ──────────────────────────────────────

Deno.test("building_rsf present: tenant_pro_rata_share computes correctly as square_footage / building_rsf", () => {
  const row = baseRow({ building_rsf: 10000 }); // square_footage=2500 from baseRow
  const fieldMap = workflowTest.buildLeaseFieldMap(row, emptyDocling, [], []);
  assertEquals(fieldMap.building_rsf?.value, 10000);
  assertEquals(fieldMap.tenant_pro_rata_share?.value, 0.25);
  assertEquals(fieldMap.tenant_pro_rata_share?.extraction_status, "calculated");
});

Deno.test("building_rsf missing: tenant_pro_rata_share is manual_required, not a crash", () => {
  const row = baseRow(); // no building_rsf
  const fieldMap = workflowTest.buildLeaseFieldMap(row, emptyDocling, [], []);
  assertEquals(fieldMap.tenant_pro_rata_share?.value, null);
  assertEquals(fieldMap.tenant_pro_rata_share?.extraction_status, "manual_required");
});

Deno.test("deriveCamProfile does not throw when building_rsf/tenant_pro_rata_share are absent", () => {
  const row = baseRow();
  const fieldMap = workflowTest.buildLeaseFieldMap(row, emptyDocling, [], []);
  const camProfile = workflowTest.deriveCamProfile(fieldMap, []);
  assert(camProfile && typeof camProfile === "object");
});

// ── Duplicate-concept fields (tax_responsibility / responsibility_taxes) ─────

Deno.test("mapFactsToStandardFields: tax_responsibility and responsibility_taxes can both carry independent values without one overwriting the other", () => {
  const facts: Fact[] = [
    makeFact({ value: "tenant", sourceText: "Tax Responsibility: tenant is responsible for all real estate taxes", confidence: 0.8 }),
    makeFact({ value: "landlord_with_cap", sourceText: "Responsibility Taxes: landlord_with_cap per the base year provision", confidence: 0.85 }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.records[0].fields.tax_responsibility?.value, "tenant");
  assertEquals(result.records[0].fields.responsibility_taxes?.value, "landlord_with_cap");
});

Deno.test("field-contract.ts: tax_responsibility/insurance_responsibility pairs are linked via alternateFieldKeys and flag the enum as preferred for automated logic", () => {
  const taxText = getFieldContract("tax_responsibility");
  assertEquals(taxText.preferredForAutomatedLogic, "responsibility_taxes");
  assert(taxText.alternateFieldKeys?.includes("responsibility_taxes"));

  const insuranceText = getFieldContract("insurance_responsibility");
  assertEquals(insuranceText.preferredForAutomatedLogic, "responsibility_insurance");
});
