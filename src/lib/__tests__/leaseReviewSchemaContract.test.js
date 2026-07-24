import { describe, it, expect } from "vitest";
import { LEASE_REVIEW_FIELDS } from "@/lib/leaseReviewSchema";
import { getFieldContract, resolveCanonicalFieldKey } from "@/lib/leaseFieldContract";

const UI_ONLY_FIELD_KEYS = new Set([
  "parking_rights",
  "common_area_description",
  "late_fee_grace_days",
  "late_fee_percent",
  "default_interest_rate_formula",
  "holdover_rent_multiplier",
  "floor_plan_reference",
  "exhibit_reference",
  "guaranty_reference",
  "renewal_option",
  "termination_option",
  "sublease_rights",
]);

describe("lease review schema contract", () => {
  it("maps every Lease Review UI field to the canonical field contract or a documented UI-only exclusion", () => {
    const failures = [];
    for (const field of LEASE_REVIEW_FIELDS) {
      const contract = getFieldContract(field.canonicalKey || field.key);
      if (!contract && !UI_ONLY_FIELD_KEYS.has(field.key)) failures.push(field.key);
    }
    expect(failures).toEqual([]);
  });

  it("keeps documented UI-only exclusions honest", () => {
    const uiKeys = new Set(LEASE_REVIEW_FIELDS.map((field) => field.key));
    for (const key of UI_ONLY_FIELD_KEYS) {
      expect(uiKeys.has(key), `${key} must remain a real UI field while documented as UI-only`).toBe(true);
      expect(getFieldContract(key), `${key} should be removed from UI_ONLY_FIELD_KEYS once canonicalized`).toBeUndefined();
    }
  });

  it("resolves legacy UI keys to the intended canonical extraction keys", () => {
    expect(resolveCanonicalFieldKey("premises_address")).toBe("property_address");
    expect(resolveCanonicalFieldKey("suite_number")).toBe("unit_number");
    expect(resolveCanonicalFieldKey("premises_use")).toBe("permitted_use");
    expect(resolveCanonicalFieldKey("lease_term")).toBe("lease_term_months");
    expect(resolveCanonicalFieldKey("assignment_rights")).toBe("assignment_provisions");
  });

  it("does not collapse legally distinct insurance and tax responsibility concepts", () => {
    expect(resolveCanonicalFieldKey("responsibility_insurance")).toBe("responsibility_insurance");
    expect(resolveCanonicalFieldKey("property_insurance_responsibility")).toBe("property_insurance_responsibility");
    expect(resolveCanonicalFieldKey("insurance_responsibility")).toBe("insurance_responsibility");
    expect(resolveCanonicalFieldKey("responsibility_taxes")).toBe("responsibility_taxes");
    expect(resolveCanonicalFieldKey("tax_responsibility")).toBe("tax_responsibility");
  });
});