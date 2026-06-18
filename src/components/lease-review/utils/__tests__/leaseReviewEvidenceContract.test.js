import { describe, expect, it } from "vitest";
import {
  hasValidSourceEvidence,
  normalizeSourcePage,
  resolveSourceTextQuality,
} from "@/lib/leaseReviewSchema";
import {
  buildDynamicDocumentFieldsByTab,
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

  it("does not treat unrelated source text as exact evidence", () => {
    const evidence = {
      value: "Cress Family Restaurants, LLC",
      sourceText: "THIS LEASE AGREEMENT made and entered into this 8 day of September, 2020.",
      sourcePage: 1,
      extractionStatus: "extracted",
    };

    expect(resolveSourceTextQuality(evidence)).toBe("missing");
    expect(hasValidSourceEvidence(evidence)).toBe(false);
  });

  it("allows exact evidence only when the source supports the value", () => {
    const evidence = {
      value: "Cress Family Restaurants, LLC",
      sourceText: "THIS LEASE AGREEMENT made by and between Markets at Choto, LLC, and Cress Family Restaurants, LLC.",
      sourcePage: 1,
      extractionStatus: "extracted",
    };

    expect(resolveSourceTextQuality(evidence)).toBe("exact");
    expect(hasValidSourceEvidence(evidence)).toBe(true);
  });

  it("keeps inferred fields visible but not source-valid", () => {
    const evidence = {
      value: "modified_gross",
      sourceText: "Pro-rata Share of Real Estate Taxes, Insurance Premiums and Common Area Maintenance Expenses.",
      sourcePage: 2,
      evidenceType: "inferred",
      extractionStatus: "inferred",
    };

    expect(resolveSourceTextQuality(evidence)).toBe("inferred");
    expect(hasValidSourceEvidence(evidence)).toBe(false);
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

  it("shows required missing fields as manual review blockers", () => {
    const row = buildCanonicalLeaseReviewField({}, {
      key: "commencement_date",
      label: "Commencement Date",
      required: true,
    }, "dates_term");

    expect(row.extraction_status).toBe("manual_required");
    expect(row.requires_review).toBe(true);
    expect(row.review_reason).toMatch(/Required field was not found/);
    expect(isReviewRowDisplayable(row, { showMissing: false })).toBe(true);
  });

  it("keeps distinct dynamic clause rows that share the same clause type", () => {
    const lease = {
      extraction_data: {
        workflow_output: {
          lease_clauses: [
            {
              clause_type: "assignment_subletting",
              clause_text: "Tenant shall not assign this Lease without Landlord's prior written consent.",
              source_page: 7,
              business_area: "legal_options",
            },
            {
              clause_type: "assignment_subletting",
              clause_text: "Any permitted assignee shall assume all obligations under this Lease.",
              source_page: 7,
              business_area: "legal_options",
            },
          ],
        },
      },
    };

    const rows = buildDynamicDocumentFieldsByTab(lease).legal_options || [];
    expect(rows.filter((row) => row.original_field_key === "clause_assignment_subletting")).toHaveLength(2);
  });

  it("repairs property name fragments from the exact premises source", () => {
    const row = buildCanonicalLeaseReviewField({}, {
      key: "property_name",
      label: "Property Name",
      normalized_value: "a shopping",
      source_page: 1,
      source_text: "Premises are located in a shopping center known as The Markets at Choto in Knoxville, Tennessee.",
    }, "parties_premises");

    expect(row.normalized_value).toBe("The Markets at Choto");
    expect(row.source_text_quality).toBe("exact");
  });

  it("rejects common-area text as permitted use", () => {
    const row = buildCanonicalLeaseReviewField({}, {
      key: "permitted_use",
      label: "Permitted Use",
      required: true,
      normalized_value: "the Common Areas adjacent to the Premises for sale or display of merchandise",
      source_page: 1,
      source_text: "Tenant accepts the Premises AS IS and acknowledges Landlord has made no representations regarding compliance.",
    }, "parties_premises");

    expect(row.normalized_value).toBeNull();
    expect(row.extraction_status).toBe("manual_required");
    expect(row.requires_review).toBe(true);
  });

  it("does not accept generic net lease type from expense wording", () => {
    const row = buildCanonicalLeaseReviewField({}, {
      key: "lease_type",
      label: "Lease Type",
      required: true,
      normalized_value: "net",
      source_page: 2,
      source_text: "Real estate taxes include the value of the Shopping Center as part of the net worth of Landlord.",
      evidence_type: "inferred",
    }, "expenses_recoveries");

    expect(row.normalized_value).toBeNull();
    expect(row.extraction_status).toBe("manual_required");
  });

  it("does not map alteration clauses into assignment provisions", () => {
    const row = buildCanonicalLeaseReviewField({}, {
      key: "assignment_provisions",
      label: "Assignment Provisions",
      normalized_value: "Tenant shall not make any alteration of, or addition or improvement to, the Premises without consent.",
      source_page: 4,
      source_text: "Tenant shall not make any alteration of, or addition or improvement to, the Premises without securing Landlord's prior written consent.",
    }, "legal_options");

    expect(row.normalized_value).toBeNull();
    expect(row.source_text).toContain("alteration");
  });
});
