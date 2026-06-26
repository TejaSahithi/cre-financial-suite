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

  it("keeps required missing fields as blockers but out of extracted-only view", () => {
    const row = buildCanonicalLeaseReviewField({}, {
      key: "commencement_date",
      label: "Commencement Date",
      required: true,
    }, "dates_term");

    expect(row.extraction_status).toBe("manual_required");
    expect(row.requires_review).toBe(true);
    expect(row.review_reason).toMatch(/Required field was not found/);
    expect(isReviewRowDisplayable(row, { showMissing: false })).toBe(false);
    expect(isReviewRowDisplayable(row, { showMissing: true })).toBe(true);
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
  it("surfaces upload-payload dynamic document items before lease backfill", () => {
    const lease = {
      uploaded_file: {
        ui_review_payload: {
          metadata: {
            workflow_output: {
              extracted_document_items: [
                {
                  item_type: "exclusive_use",
                  label: "Exclusive Use",
                  business_area: "legal_options",
                  value: "No exclusive use right stated",
                  source_text: "Tenant shall have no exclusive right to sell any particular product in the Building.",
                  source_page: 18,
                  creates_dynamic_row: true,
                },
              ],
            },
          },
        },
      },
    };

    const rows = buildDynamicDocumentFieldsByTab(lease).legal_options || [];
    expect(rows.some((row) => row.original_field_key === "exclusive_use")).toBe(true);
    expect(rows[0].source_text).toContain("exclusive right");
  });

  it("routes typed backend clauses into review tabs as dynamic rows", () => {
    const lease = {
      extraction_data: {
        workflow_output: {
          lease_clauses: [
            {
              clause_type: "force_majeure",
              clause_title: "Force Majeure",
              clause_text: "Neither party shall be liable for delays caused by force majeure events beyond its control.",
              source_page: 22,
              business_area: "legal_options",
              display_tab: "legal_options",
            },
          ],
        },
      },
    };

    const rows = buildDynamicDocumentFieldsByTab(lease).legal_options || [];
    expect(rows.some((row) => row.original_field_key === "clause_force_majeure")).toBe(true);
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
  it("rejects a date captured as tenant name", () => {
    const row = buildCanonicalLeaseReviewField({}, {
      key: "tenant_name",
      label: "Tenant Name",
      required: true,
      normalized_value: "January 9, 2024",
      source_page: 1,
      source_text: "Tenant: January 9, 2024",
    }, "parties_premises");

    expect(row.normalized_value).toBeNull();
    expect(row.extraction_status).toBe("manual_required");
    expect(row.validation_errors).toContain("tenant_name_failed_validation");
    expect(row.review_reason).toMatch(/failed field validation/i);
  });

  it("recovers landlord from source-backed intro clause when stale value is invalid", () => {
    const row = buildCanonicalLeaseReviewField({}, {
      key: "landlord_name",
      label: "Landlord Name",
      required: true,
      normalized_value: "3",
      source_page: 1,
      source_text: 'THIS LEASE is made January 9, 2024 by and between 224 Partners, LLC ("Landlord") and Mindful Tech Solutions Inc - Narendra Pydi (Tenant).',
      validation_errors: ["landlord_name_failed_validation"],
      review_reason: "Required field was not found in the lease. Manual review required.",
      requires_review: true,
    }, "parties_premises");

    expect(row.normalized_value).toBe("224 Partners, LLC");
    expect(row.validation_errors).toEqual([]);
    expect(row.requires_review).toBe(false);
    expect(row.source_text_quality).toBe("exact");
  });

  it("recovers tenant company from source-backed intro clause when stale value is a date", () => {
    const row = buildCanonicalLeaseReviewField({}, {
      key: "tenant_name",
      label: "Tenant Name",
      required: true,
      normalized_value: "January 9, 2024",
      source_page: 1,
      source_text: 'THIS LEASE is made January 9, 2024 by and between 224 Partners, LLC ("Landlord") and Mindful Tech Solutions Inc - Narendra Pydi (Tenant).',
      validation_errors: ["tenant_name_failed_validation"],
      review_reason: "Extracted value failed field validation.",
      requires_review: true,
    }, "parties_premises");

    expect(row.normalized_value).toBe("Mindful Tech Solutions Inc");
    expect(row.validation_errors).toEqual([]);
    expect(row.requires_review).toBe(false);
    expect(row.source_text_quality).toBe("exact");
  });

  it("recovers permitted use from compact page-one summary labels", () => {
    const row = buildCanonicalLeaseReviewField({}, {
      key: "permitted_use",
      label: "Permitted Use",
      required: true,
      normalized_value: null,
      source_page: 1,
      source_text: "9. Rent: $1,400 per month 10. Permitted Use: IT work 11. Brokers: Brownlee Realty, LLC",
      validation_errors: ["no_valid_supporting_source"],
      review_reason: "Required field has a value but no valid supporting source text.",
      requires_review: true,
    }, "parties_premises");

    expect(row.normalized_value).toBe("IT work");
    expect(row.validation_errors).toEqual([]);
    expect(row.requires_review).toBe(false);
    expect(row.source_text_quality).toBe("exact");
  });
  it("does not show transfer clause text as an assignee name", () => {
    const row = buildCanonicalLeaseReviewField({}, {
      key: "assignee_name",
      label: "Assignee Name",
      normalized_value: "assumes, in full, the obligations of Tenant under this Lease",
      source_page: 4,
      source_text: "Notwithstanding the foregoing a Transfer shall not include a Permitted Transfer provided that the transferee assumes, in full, the obligations of Tenant under this Lease.",
    }, "parties_premises");

    expect(row.normalized_value).toBeNull();
  });


  it("normalizes a rent summary sentence to the monthly rent amount only", () => {
    const row = buildCanonicalLeaseReviewField({}, {
      key: "monthly_rent",
      label: "Monthly Rent",
      required: true,
      normalized_value: "$1,400 per month Full Service Lease 30 days before each anniversary of the Lease, Rent will increase 5% each year of renewal. The 10. Security Deposit $1,400",
      source_page: 1,
      source_text: "Rent: $1,400 per month Full Service Lease 30 days before each anniversary of the Lease, Rent will increase 5% each year of renewal. The 10. Security Deposit $1,400",
    }, "rent_charges");

    expect(row.normalized_value).toBe(1400);
    expect(row.source_text).toContain("Security Deposit $1,400");
    expect(row.validation_errors).not.toContain("monthly_rent_failed_validation");
  });

  it("does not display a backend-rejected property fragment as a trusted value", () => {
    const row = buildCanonicalLeaseReviewField({}, {
      key: "property_name",
      label: "Property Name",
      normalized_value: "Tenant has",
      source_page: 2,
      source_text: "at Tenant has park",
      validation_errors: ["property_name_not_specific"],
      requires_review: true,
    }, "parties_premises");

    expect(row.normalized_value).toBeNull();
    expect(row.validation_errors).toContain("property_name_not_specific");
    expect(row.requires_review).toBe(true);
  });  it("upgrades unsupported annual rent to a traced derived value", () => {
    const lease = {
      extraction_data: {
        workflow_output: {
          lease_fields: {
            monthly_rent: {
              value: 1400,
              source_page: 1,
              source_clause: "$1,400 per month",
              extraction_status: "extracted",
            },
            annual_rent: {
              value: 16800,
              extraction_status: "missing_source_evidence",
            },
          },
        },
      },
    };

    const row = buildCanonicalLeaseReviewField(lease, { key: "annual_rent", label: "Annual Rent" }, "rent_charges");

    expect(row.normalized_value).toBe(16800);
    expect(row.evidence_type).toBe("derived");
    expect(row.derivation_trace).toContain("monthly_rent");
    expect(row.source_field_keys).toContain("monthly_rent");
  });

  it("rejects generic lease intro as responsibility evidence", () => {
    const row = buildCanonicalLeaseReviewField({}, {
      key: "responsibility_taxes",
      label: "Taxes Responsibility",
      normalized_value: "Landlord",
      source_page: 2,
      source_text: "THIS LEASE is made January 9, 2024 by and between 224 Partners, LLC (Landlord) and Mindful Tech Solutions Inc - Narendra Pydi (Tenant). ARTICLE 1 LEASE OF PREMISES in consideration of the Rent.",
    }, "expenses_recoveries");

    expect(row.normalized_value).toBeNull();
  });

  it("rejects punctuation-only assignment consideration", () => {
    const row = buildCanonicalLeaseReviewField({}, {
      key: "assignment_consideration",
      label: "Assignment Consideration",
      normalized_value: ".",
      source_page: 1,
      source_text: "SUMMARY OF BASIC LEASE INFORMATION",
    }, "rent_charges");

    expect(row.normalized_value).toBeNull();
  });

  it("does not show CAM Amount as $0 without supporting source", () => {
    const row = buildCanonicalLeaseReviewField({}, {
      key: "cam_amount",
      label: "CAM Amount",
      normalized_value: 0,
      source_text: "SUMMARY OF BASIC LEASE INFORMATION",
      source_page: 1,
    }, "cam_rules");

    expect(row.normalized_value).toBeNull();
    expect(row.validation_errors).toContain("cam_amount_failed_validation");
    expect(row.requires_review).toBe(true);
  });
  it("uses clause_text as source evidence, not as the normalized value", () => {
    const lease = {
      extraction_data: {
        workflow_output: {
          lease_clauses: [
            {
              clause_type: "repairs_maintenance",
              clause_text: "Tenant shall maintain the Premises in good order and repair throughout the Term.",
              source_page: 4,
              business_area: "expenses_recoveries",
            },
          ],
        },
      },
    };

    const rows = buildDynamicDocumentFieldsByTab(lease).expenses_recoveries || [];
    const row = rows.find((item) => item.original_field_key === "clause_repairs_maintenance");
    expect(row).toBeTruthy();
    expect(row.normalized_value).toBeNull();
    expect(row.source_text).toContain("Tenant shall maintain");
    expect(row.requires_review).toBe(false);
  });

  it("rehydrates legacy OCR paragraphs as source text instead of dynamic values", () => {
    const lease = {
      extraction_data: {
        workflow_output: {
          extracted_document_items: [
            {
              item_type: "operating_expense_recovery",
              label: "Operating Expense Recovery",
              business_area: "expenses_recoveries",
              value: "ARTICLE 2 DEFINITIONS As used in this Lease, Additional Rent shall include taxes, insurance, maintenance and utilities described in the Lease.",
              source_page: 2,
              creates_dynamic_row: true,
            },
          ],
        },
      },
    };

    const rows = buildDynamicDocumentFieldsByTab(lease).expenses_recoveries || [];
    const row = rows.find((item) => item.original_field_key === "operating_expense_recovery");
    expect(row).toBeTruthy();
    expect(row.normalized_value).toBeNull();
    expect(row.source_text).toContain("Additional Rent shall include");
  });

  it("does not carry stale no-source validation onto traced derived annual rent", () => {
    const lease = {
      extraction_data: {
        workflow_output: {
          lease_fields: {
            monthly_rent: {
              value: 1400,
              source_page: 1,
              source_clause: "$1,400 per month",
              extraction_status: "extracted",
            },
            annual_rent: {
              value: 16800,
              validation_errors: ["money_field_without_money_evidence", "annual_rent_failed_validation"],
              requires_review: true,
              review_reason: "Extracted value has no valid supporting source text.",
              extraction_status: "missing_source_evidence",
            },
          },
        },
      },
    };

    const row = buildCanonicalLeaseReviewField(lease, { key: "annual_rent", label: "Annual Rent" }, "rent_charges");
    expect(row.normalized_value).toBe(16800);
    expect(row.evidence_type).toBe("derived");
    expect(row.validation_errors).toEqual([]);
    expect(row.requires_review).toBe(false);
    expect(row.derivation_trace).toContain("monthly_rent");
  });
});
