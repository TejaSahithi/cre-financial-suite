import { describe, expect, it } from "vitest";
import {
  hasValidSourceEvidence,
  normalizeSourcePage,
  resolveSourceTextQuality,
} from "@/lib/leaseReviewSchema";
import {
  buildCanonicalLeaseReviewField,
  isReviewRowDisplayable,
} from "@/components/lease-review/utils/dynamicFields";

const baseLease = {
  extraction_data: {
    workflow_output: {
      lease_fields: {
        monthly_rent: {
          value: 1400,
          source_page: 12,
          source_clause: "Tenant shall pay monthly base rent in the amount of $1,400.00 per month.",
          confidence_score: 0.86,
          extraction_status: "extracted",
        },
        square_footage: {
          value: 3200,
          source_page: 1,
          source_clause: "The Premises contain Three Thousand Two Hundred (3,200) rentable square feet.",
          confidence_score: 0.92,
          extraction_status: "extracted",
        },
      },
    },
  },
};

describe("Lease Review evidence contract", () => {
  it("treats source text without a page as partial evidence, not no source", () => {
    const evidence = {
      value: "restaurant",
      sourceText: "Tenant shall use the Premises solely for restaurant purposes.",
    };

    expect(resolveSourceTextQuality(evidence)).toBe("partial");
    expect(hasValidSourceEvidence(evidence)).toBe(true);
  });

  it("does not default missing page numbers to page 1", () => {
    expect(normalizeSourcePage(null)).toBeNull();
    expect(normalizeSourcePage(undefined)).toBeNull();
    expect(normalizeSourcePage("")).toBeNull();
  });

  it("derives annual rent from monthly rent with supporting evidence", () => {
    const row = buildCanonicalLeaseReviewField(baseLease, {
      key: "annual_rent",
      label: "Annual Rent",
      allowCalculatedAccept: true,
    }, "rent_charges");

    expect(row.normalized_value).toBe(16800);
    expect(row.evidence_type).toBe("derived");
    expect(row.source_text_quality).toBe("derived");
    expect(row.source_field_keys).toContain("monthly_rent");
    expect(row.source_text).toContain("$1,400.00 per month");
    expect(isReviewRowDisplayable(row)).toBe(true);
  });

  it("derives rent per square foot from annual rent inputs with source text", () => {
    const row = buildCanonicalLeaseReviewField(baseLease, {
      key: "rent_per_sf",
      label: "Base Rent ($/SF/yr)",
      allowCalculatedAccept: true,
    }, "rent_charges");

    expect(row.normalized_value).toBe(5.25);
    expect(row.evidence_type).toBe("derived");
    expect(row.source_field_keys).toEqual(expect.arrayContaining(["monthly_rent", "square_footage"]));
    expect(row.source_text).toContain("rentable square feet");
  });

  it("derives billing frequency from monthly rent evidence", () => {
    const row = buildCanonicalLeaseReviewField(baseLease, {
      key: "billing_frequency",
      label: "Billing Frequency",
      allowCalculatedAccept: true,
    }, "rent_charges");

    expect(row.normalized_value).toBe("monthly");
    expect(row.evidence_type).toBe("derived");
    expect(row.source_text_quality).toBe("derived");
  });
});
