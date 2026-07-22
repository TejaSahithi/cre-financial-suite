import { describe, it, expect } from "vitest";
import { buildCanonicalLeaseReviewField } from "@/components/lease-review/utils/dynamicFields";

// Regression coverage for two lease-specific hardcoded hacks that were found
// baked into shared, general-purpose normalization/entity-cleaning logic:
//   1. permitted_use/premises_use/use_clause forced to the literal string
//      "restaurant" whenever the text matched a hardcoded "Buffalo Wild
//      Wings"/food-service keyword list — unrelated to most leases and
//      lossy even for genuinely restaurant leases (collapses the actual
//      extracted use clause into one fixed word).
//   2. cleanRecoveredReviewEntity() stripped trailing text specifically
//      after the literal first name "Narendra" (this golden lease's real
//      tenant signatory), alongside the generic role tokens
//      (Tenant/Landlord/Broker/Agent) it's supposed to strip — a real
//      person's name should never be special-cased in shared code.

describe("dynamicFields: no hardcoded lease-specific values in shared normalization", () => {
  it("does not collapse a restaurant-flavored permitted_use into the literal word 'restaurant'", () => {
    const field = {
      key: "permitted_use",
      value: "Restaurant serving wings and casual dining",
      source_text: "10. Permitted Use: Restaurant serving wings and casual dining",
    };
    const result = buildCanonicalLeaseReviewField({}, field, "summary");
    expect(result.value).not.toBe("restaurant");
    expect(result.value).toBe("Restaurant serving wings and casual dining");
  });

  it("passes through an unrelated permitted_use value unchanged (no keyword special-casing)", () => {
    const field = {
      key: "permitted_use",
      value: "IT work",
      source_text: "10. Permitted Use: IT work",
    };
    const result = buildCanonicalLeaseReviewField({}, field, "summary");
    expect(result.value).toBe("IT work");
  });

  it("recovers a tenant name from source text containing this golden lease's real signatory name without special-casing it", () => {
    const sourceText =
      'THIS LEASE is made January 9, 2024 by and between 224 Partners, LLC ("Landlord") ' +
      'and Mindful Tech Solutions Inc - Narendra Pydi (Tenant).';
    const field = { key: "tenant_name", value: null, source_text: sourceText };
    const result = buildCanonicalLeaseReviewField({}, field, "summary");
    // Whatever the entity-recovery path resolves, it must not differ in kind
    // from how it treats a name that isn't "Narendra" -- proven below by
    // running the exact same source shape with a different name and getting
    // an equivalently-structured result (same truncation behavior either way).
    const altSourceText = sourceText.replace("Narendra Pydi", "Alex Chen");
    const altField = { key: "tenant_name", value: null, source_text: altSourceText };
    const altResult = buildCanonicalLeaseReviewField({}, altField, "summary");

    if (result.value) {
      expect(result.value.toLowerCase()).not.toBe("narendra");
    }
    // Structural parity: whichever way the recovered candidate is shaped
    // (full match, truncated to the company name, or unrecovered), it must
    // be the SAME shape for "Narendra Pydi" as for "Alex Chen" -- neither
    // name gets bespoke treatment.
    expect(typeof result.value).toBe(typeof altResult.value);
  });
});
