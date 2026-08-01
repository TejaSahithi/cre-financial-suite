import { describe, expect, it } from "vitest";
import { normalizeLeaseReviewData as normalizeLeaseReviewDataBase } from "../leaseReviewFieldNormalizer";

function normalizeLeaseReviewData(lease, options = {}) {
  return normalizeLeaseReviewDataBase(lease, { allowDiagnosticExpenseRuleFallbacks: true, ...options });
}

function extracted(value, sourcePage, sourceText, confidence = 0.95, extra = {}) {
  return {
    value,
    source_page: sourcePage,
    source_text: sourceText,
    confidence,
    extraction_status: "extracted",
    ...extra,
  };
}

function leaseFixture({ profile = "base_lease", fields = {}, workflow = {}, uploadedFile = {} } = {}) {
  return {
    id: `${profile}-fixture`,
    abstract_status: "approved",
    document_subtype: profile,
    extraction_data: {
      fields,
      workflow_output: {
        document_profile: { documentType: profile },
        selected_document_profile: profile,
        expense_rules: [],
        lease_clauses: [],
        extracted_document_items: [],
        ...workflow,
      },
    },
    uploaded_file: uploadedFile,
  };
}

function standardRow(result, key) {
  return result.standardFields.find((row) => row.canonicalKey === key);
}

function tabRow(result, tab, keyOrPredicate) {
  const predicate = typeof keyOrPredicate === "function"
    ? keyOrPredicate
    : (row) => row.canonicalKey === keyOrPredicate || row.fieldKey === keyOrPredicate || row.category === keyOrPredicate;
  return (result.tabs[tab] || []).find(predicate);
}

const baseFields = {
  tenant_name: extracted("Acme Retail LLC", 1, "Tenant: Acme Retail LLC", 0.97),
  landlord_name: extracted("Market Owner LLC", 1, "Landlord: Market Owner LLC", 0.96),
  property_address: extracted("123 Market Street, Suite 100", 2, "Premises located at 123 Market Street, Suite 100", 0.95),
  square_footage: extracted(5000, 2, "The Premises contain 5,000 rentable square feet", 0.94),
  commencement_date: extracted("2026-01-01", 3, "Commencement Date: 2026-01-01", 0.93),
  expiration_date: extracted("2031-12-31", 3, "Expiration Date: 2031-12-31", 0.93),
  monthly_rent: extracted(12500, 4, "Monthly Rent: $12,500", 0.96),
  lease_type: extracted("nnn", 5, "This Lease is a triple net (NNN) lease", 0.91),
  tenant_insurance_required: extracted(true, 8, "Tenant shall maintain insurance", 0.9),
  general_liability_min: extracted(2000000, 8, "Commercial general liability insurance of $2,000,000", 0.9),
  renewal_options: extracted("One five-year renewal option", 12, "Tenant has one five-year renewal option", 0.88),
};

const mixedRules = [
  {
    id: "cam-1",
    expense_category: "common_area_maintenance",
    normalized_rule: "Tenant pays CAM as additional rent.",
    responsible_party: "tenant",
    recoverable: true,
    source_page: 6,
    exact_source_text: "Tenant shall pay common area maintenance charges as Additional Rent.",
  },
  {
    id: "tax-1",
    expense_category: "real_estate_taxes",
    normalized_rule: "Tenant pays its share of real estate taxes.",
    responsible_party: "shared",
    recoverable: true,
    source_page: 7,
    exact_source_text: "Tenant shall reimburse Landlord for its pro rata share of real estate taxes.",
  },
  {
    id: "insurance-1",
    expense_category: "property_insurance",
    normalized_rule: "Tenant reimburses property insurance premiums.",
    responsible_party: "tenant",
    recoverable: true,
    source_page: 8,
    exact_source_text: "Tenant shall reimburse property insurance premiums.",
  },
];

describe("Phase 5A Lease Review contract fixtures", () => {
  it("standard base lease projects fields, evidence, confidence, dynamic findings, CAM, and expense rules into business tabs", () => {
    const result = normalizeLeaseReviewData(leaseFixture({
      fields: baseFields,
      workflow: {
        expense_rules: mixedRules,
        extracted_document_items: [
          {
            item_type: "insurance_deductible",
            label: "Insurance Deductible",
            value: "$25,000",
            business_area: "insurance",
            source_page: 8,
            source_text: "Insurance deductible shall not exceed $25,000.",
            confidence: 0.82,
          },
        ],
      },
    }));

    expect(result.currentReviewPolicy.profile).toBe("base_lease");
    expect(result.standardFields.filter((row) => row.value !== null && row.value !== undefined && row.value !== "").length).toBeGreaterThan(8);

    expect(tabRow(result, "parties_premises", "tenant_name")?.value).toBe("Acme Retail LLC");
    expect(tabRow(result, "dates_term", "commencement_date")?.sourcePage).toBe(3);
    expect(tabRow(result, "rent_charges", "monthly_rent")?.confidencePercent).toBe(96);
    expect(tabRow(result, "insurance", "tenant_insurance_required")?.status).toBe("auto_populated");
    expect(tabRow(result, "legal_options", "renewal_options")?.sourceText).toContain("renewal option");

    expect(tabRow(result, "insurance", (row) => row.rowType === "dynamic" && row.label === "Insurance Deductible")).toBeTruthy();
    expect(result.camRules.some((row) => row.category === "common_area_maintenance" && row.sourcePage === 6)).toBe(true);
    expect(result.expenseRules.some((row) => row.category === "real_estate_taxes" && row.sourcePage === 7)).toBe(true);
    expect(result.tabs.cam_rules.some((row) => row.rowType === "cam_rule")).toBe(true);
    expect(result.tabs.expenses_recoveries.some((row) => row.rowType === "expense_rule")).toBe(true);
  });

  it("triple-net fixture keeps CAM/recovery rules separate from expense rows and marks extracted rules for review", () => {
    const result = normalizeLeaseReviewData(leaseFixture({
      fields: {
        ...baseFields,
        lease_type: extracted("nnn", 5, "Tenant shall pay all costs under this triple net lease", 0.92),
      },
      workflow: {
        expense_rules: [
          ...mixedRules,
          {
            id: "utilities-1",
            expense_category: "utilities",
            normalized_rule: "Tenant pays separately metered utilities.",
            source_page: 9,
            exact_source_text: "Tenant shall pay separately metered utilities directly.",
          },
          {
            id: "audit-1",
            expense_category: "annual_reconciliation",
            normalized_rule: "Tenant may audit annual reconciliation statements.",
            source_page: 10,
            exact_source_text: "Tenant may audit the annual reconciliation statement within 90 days.",
          },
        ],
      },
    }));

    expect(standardRow(result, "lease_type")?.value).toBe("nnn");
    expect(result.camRules.map((row) => row.category)).toEqual(expect.arrayContaining(["common_area_maintenance", "annual_reconciliation"]));
    expect(result.expenseRules.map((row) => row.category)).toEqual(expect.arrayContaining(["real_estate_taxes", "property_insurance", "utilities"]));
    expect(result.camRules.every((row) => row.status === "needs_review")).toBe(true);
    expect(result.expenseRules.every((row) => row.status === "needs_review")).toBe(true);
    expect(result.camRules.some((cam) => result.expenseRules.some((expense) => expense.key === cam.key))).toBe(false);
  });

  it("assignment and amendment documents do not inherit base-lease approval blockers", () => {
    const assignment = normalizeLeaseReviewData(leaseFixture({
      profile: "assignment",
      fields: {
        assignee_name: extracted("New Tenant LLC", 1, "Assignee: New Tenant LLC", 0.94),
        assignment_effective_date: extracted("2026-02-01", 1, "Assignment Effective Date: 2026-02-01", 0.94),
      },
    }));

    const amendment = normalizeLeaseReviewData(leaseFixture({
      profile: "amendment",
      fields: {
        assignee_name: extracted("New Tenant LLC", 1, "Assignee: New Tenant LLC", 0.94),
        assignment_effective_date: extracted("2026-02-01", 1, "Effective Date: 2026-02-01", 0.94),
        all_other_terms_remain_same: extracted(true, 2, "Except as amended, all other terms remain unchanged.", 0.9),
      },
    }));

    for (const result of [assignment, amendment]) {
      expect(result.currentReviewPolicy.applyBaseLeaseBlockers).toBe(false);
      expect(result.readinessSummary.missingRequiredFields).not.toContain("monthly_rent");
      expect(result.readinessSummary.missingRequiredFields).not.toContain("lease_type");
      expect(result.approvalBlockers.budgetBlockers).toEqual([]);
      expect(result.approvalBlockers.camBlockers).toEqual([]);
    }
  });

  it("missing optional clauses remain empty rather than fabricated", () => {
    const result = normalizeLeaseReviewData(leaseFixture({ fields: baseFields }));

    expect(result.expenseRules).toEqual([]);
    expect(result.camRules).toEqual([]);
    expect(result.dynamicFindings).toEqual([]);
    expect(result.readinessSummary.expenseRulesReadiness).toBe("no_rules_found");
  });

  it("conflicting facts stay visible as needs_review instead of becoming an automatic rejection", () => {
    const result = normalizeLeaseReviewData(leaseFixture({
      fields: {
        ...baseFields,
        monthly_rent: extracted(12500, 4, "Monthly rent appears as both $12,500 and $13,000.", 0.8, {
          extraction_status: "conflict_detected",
          evidence_type: "conflict",
          source_text_quality: "conflict",
        }),
      },
    }));

    const rent = standardRow(result, "monthly_rent");
    expect(rent?.value).toBe(12500);
    expect(rent?.status).toBe("needs_review");
    expect(result.readinessSummary.needsReviewFields).toContain("monthly_rent");
  });

  it("reviewer field_reviews survive automated retry views and keep edited status authoritative", () => {
    const fieldReviews = {
      monthly_rent: { status: "edited", value: 13000, note: "Reviewer confirmed latest rent schedule." },
    };

    const first = normalizeLeaseReviewData(leaseFixture({ fields: baseFields }), { fieldReviews });
    const retry = normalizeLeaseReviewData(leaseFixture({
      fields: {
        ...baseFields,
        monthly_rent: extracted(99999, 4, "Automated retry misread Monthly Rent: $99,999", 0.97),
      },
    }), { fieldReviews });

    expect(first.standardFields.find((row) => row.canonicalKey === "monthly_rent")?.status).toBe("manually_edited");
    expect(retry.standardFields.find((row) => row.canonicalKey === "monthly_rent")?.status).toBe("manually_edited");
    expect(fieldReviews.monthly_rent).toEqual({ status: "edited", value: 13000, note: "Reviewer confirmed latest rent schedule." });
  });
});
