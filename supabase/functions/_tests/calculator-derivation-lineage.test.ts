// @ts-nocheck
// Regression tests for _shared/extraction/calculator.ts -- previously zero
// direct test coverage (cam-calculation.test.ts and
// lease-financial-calculation-rent-charge.test.ts exercise different,
// unrelated calculator modules). Covers both existing derived-field
// behavior (annual_rent/monthly_rent/rent_per_sf/square_footage/
// lease_term_months) and the new source-field lineage
// (_derivation_source_fields) added alongside the pre-existing formula-
// string trace (_derivation_traces) -- leaseReviewSchema.js's
// readFieldEvidence() already expected and read this shape
// (source_field_keys / sourceFieldKeys), but nothing on the backend
// populated it for the fields only calculator.ts derives.
//
// Run: deno test --allow-env --no-lock calculator-derivation-lineage.test.ts

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { computeDerivedFields } from "../_shared/extraction/calculator.ts";

Deno.test("computeDerivedFields: annual_rent derived from monthly_rent, with formula trace and source_field_keys", () => {
  const rows = [{ monthly_rent: 1400, annual_rent: null }];
  computeDerivedFields(rows, "lease");
  const row = rows[0];
  assertEquals(row.annual_rent, 16800);
  assertExists(row._derivation_traces.annual_rent);
  assertEquals(row._derivation_source_fields.annual_rent, ["monthly_rent"]);
});

Deno.test("computeDerivedFields: monthly_rent derived from annual_rent, with source_field_keys", () => {
  const rows = [{ monthly_rent: null, annual_rent: 16800 }];
  computeDerivedFields(rows, "lease");
  const row = rows[0];
  assertEquals(row.monthly_rent, 1400);
  assertEquals(row._derivation_source_fields.monthly_rent, ["annual_rent"]);
});

Deno.test("computeDerivedFields: currency-formatted annual_rent derives monthly_rent correctly", () => {
  const rows = [{ monthly_rent: null, annual_rent: "$25,200.00" }];
  computeDerivedFields(rows, "lease");
  const row = rows[0];
  assertEquals(row.monthly_rent, 2100);
  assertEquals(row._derivation_source_fields.monthly_rent, ["annual_rent"]);
});

Deno.test("computeDerivedFields: rent_per_sf derived from annual_rent and square_footage, with both source_field_keys", () => {
  const rows = [{ monthly_rent: 1400, annual_rent: 16800, square_footage: 1110, rent_per_sf: null }];
  computeDerivedFields(rows, "lease");
  const row = rows[0];
  assertExists(row.rent_per_sf);
  assertEquals(row._derivation_source_fields.rent_per_sf, ["annual_rent", "square_footage"]);
});

Deno.test("computeDerivedFields: lease_term_months derived from start_date/end_date, with source_field_keys", () => {
  const rows = [{ start_date: "2024-02-01", end_date: "2025-01-31", lease_term_months: null }];
  computeDerivedFields(rows, "lease");
  const row = rows[0];
  assertEquals(row.lease_term_months, 12);
  assertEquals(row._derivation_source_fields.lease_term_months, ["start_date", "end_date"]);
});

Deno.test("computeDerivedFields: lease_term_months already extracted still gets a confirmed trace and source_field_keys, value untouched", () => {
  const rows = [{ start_date: "2024-02-01", end_date: "2025-01-31", lease_term_months: 12 }];
  computeDerivedFields(rows, "lease");
  const row = rows[0];
  assertEquals(row.lease_term_months, 12);
  assertEquals(row._derivation_traces.lease_term_months.startsWith("confirmed:"), true);
  assertEquals(row._derivation_source_fields.lease_term_months, ["start_date", "end_date"]);
});

Deno.test("computeDerivedFields: a field with no calculation performed has no lineage entry", () => {
  const rows = [{ monthly_rent: 1400, annual_rent: 16800 }];
  computeDerivedFields(rows, "lease");
  const row = rows[0];
  // Both already present -- neither annual_rent nor monthly_rent should be
  // (re-)derived, so neither gets a lineage entry.
  assertEquals(row._derivation_source_fields?.annual_rent, undefined);
  assertEquals(row._derivation_source_fields?.monthly_rent, undefined);
});

Deno.test("computeDerivedFields: monthly_rent that is actually an annual figure (mislabeled) gets swapped when square_footage makes the as-extracted rate absurd", () => {
  // 25200 recorded as "monthly" with 300 sqft implies 1008 $/SF/yr as-extracted
  // (absurd, >500 threshold) but a plausible 84 $/SF/yr if 25200 is actually
  // the annual figure -- the exact "annual amount recorded as monthly_rent"
  // failure mode this guard exists for.
  const rows = [{ monthly_rent: 25200, annual_rent: null, square_footage: 300 }];
  computeDerivedFields(rows, "lease");
  const row = rows[0];
  assertEquals(row.monthly_rent, 2100);
  assertEquals(row.annual_rent, 25200);
  assertEquals(row._derivation_needs_review.monthly_rent, true);
  assertEquals(row._derivation_needs_review.annual_rent, true);
});

Deno.test("computeDerivedFields: a genuinely high monthly rent is NOT swapped when the implied PSF stays in the plausible band", () => {
  // 25200/month at 1875 sqft implies ~161 $/SF/yr as-extracted -- a real,
  // if high, retail rate, not absurd enough to cross the 500 $/SF/yr
  // threshold. Must NOT trigger the swap guard -- confirms the deliberately
  // conservative threshold doesn't misfire on legitimately high-PSF leases.
  const rows = [{ monthly_rent: 25200, annual_rent: null, square_footage: 1875 }];
  computeDerivedFields(rows, "lease");
  const row = rows[0];
  assertEquals(row.monthly_rent, 25200);
  assertEquals(row.annual_rent, 302400);
  assertEquals(row._derivation_needs_review, undefined);
});

Deno.test("computeDerivedFields: swap guard does not fire without square_footage (existing <300 PSF guard is unaffected)", () => {
  const rows = [{ monthly_rent: 1400, annual_rent: null }];
  computeDerivedFields(rows, "lease");
  const row = rows[0];
  assertEquals(row.monthly_rent, 1400);
  assertEquals(row.annual_rent, 16800);
  assertEquals(row._derivation_needs_review, undefined);
});

Deno.test("computeDerivedFields: non-lease module types are untouched (no derived-field code path for them here)", () => {
  const rows = [{ noi: 100000, market_value: 1000000, cap_rate: null }];
  computeDerivedFields(rows, "property");
  const row = rows[0];
  assertEquals(row.cap_rate, 10);
  // property module's calculator doesn't use setDerived/lineage at all --
  // confirms this addition didn't leak into unrelated module types.
  assertEquals(row._derivation_source_fields, undefined);
});
