import { describe, expect, it } from "vitest";
import { normalizeLeaseReviewData } from "../leaseReviewFieldNormalizer";
import { splitRulesForLeaseReview } from "../../services/utils/leaseExpenseRuleTaxonomy";
import { mergeLatestExtraction } from "../../components/lease-review/utils/applyLatestExtractionMerge";
import { resolveBudgetPreviewInputs } from "../../components/lease-review/utils/budgetPreviewInputs";

function extracted(value, page = 1, text = "Sanitized source clause.", confidence = 0.95, extra = {}) {
  return {
    value,
    source_page: page,
    source_text: text,
    confidence,
    extraction_status: "extracted",
    ...extra,
  };
}

const baseFields = {
  landlord_name: extracted("Phase 5B Owner LLC", 1),
  tenant_name: extracted("Phase 5B Tenant LLC", 1),
  property_address: extracted("500 Local Validation Ave, Suite 120", 2),
  commencement_date: extracted("2026-01-01", 3),
  expiration_date: extracted("2031-12-31", 3),
  lease_term: extracted("72 months", 3),
  monthly_rent: extracted(12500, 4),
  lease_type: extracted("nnn", 5),
  escalation_rate: extracted(3, 5),
  tenant_insurance_required: extracted(true, 8),
  renewal_options: extracted("One five-year renewal option", 12),
  security_deposit: extracted(30000, 4, "Security deposit appears as two sanitized values.", 0.8, {
    extraction_status: "conflict_detected",
    evidence_type: "conflict",
    source_text_quality: "conflict",
  }),
};

const workflowRules = [
  {
    id: "accepted-cam-reconciliation",
    expense_category: "annual_reconciliation",
    normalized_rule: "Annual CAM reconciliation required.",
    responsible_party: "landlord",
    recoverable: true,
    source_page: 6,
    exact_source_text: "Sanitized annual reconciliation clause.",
    confidence_score: 0.86,
    review_status: "approved",
  },
  {
    id: "uncertain-true-up",
    expense_category: "true_up",
    normalized_rule: "True-up mechanics require reviewer confirmation.",
    responsible_party: "shared",
    recoverable: true,
    source_page: 6,
    exact_source_text: "Sanitized true-up clause.",
    confidence_score: 0.74,
    review_status: "needs_review",
  },
  {
    id: "accepted-tax",
    expense_category: "real_estate_taxes",
    normalized_rule: "Tenant reimburses real estate taxes.",
    responsible_party: "tenant",
    recoverable: true,
    source_page: 9,
    exact_source_text: "Sanitized tax reimbursement clause.",
    confidence_score: 0.88,
    review_status: "approved",
  },
  {
    id: "utilities-review",
    expense_category: "utilities",
    normalized_rule: "Tenant pays separately metered utilities.",
    responsible_party: "tenant",
    recoverable: true,
    source_page: 10,
    exact_source_text: "Sanitized utility clause.",
    confidence_score: 0.84,
    review_status: "needs_review",
  },
];

function leaseFixture({ profile = "base_lease", fields = baseFields, fieldReviews = {}, rules = workflowRules } = {}) {
  return {
    id: `${profile}-phase5b`,
    abstract_status: "approved",
    document_subtype: profile,
    monthly_rent: 99999,
    commencement_date: "2026-02-01",
    escalation_rate: 9,
    extraction_data: {
      fields,
      field_reviews: fieldReviews,
      workflow_output: {
        document_profile: { documentType: profile },
        selected_document_profile: profile,
        expense_rules: rules,
        lease_clauses: [
          { clause_type: "renewal_option", clause_text: "Sanitized renewal clause.", source_page: 12, confidence_score: 0.88 },
        ],
        budget_preview: {
          rent_revenue_budget: [{ monthly_rent: 10000, start_date: "2026-02-01" }],
        },
      },
    },
  };
}

describe("Phase 5B review-to-financial workflow contract", () => {
  it("projects reviewed base lease fields, expense decisions, CAM decisions, conflicts, and budget inputs from one authority chain", () => {
    const lease = leaseFixture({
      fieldReviews: {
        monthly_rent: { status: "edited", value: 13000, note: "Reviewer confirmed schedule." },
        commencement_date: { status: "accepted", value: "2026-03-01" },
        tenant_name: { status: "accepted" },
      },
    });

    const normalized = normalizeLeaseReviewData(lease, { fieldReviews: lease.extraction_data.field_reviews });
    const rent = normalized.standardFields.find((row) => row.canonicalKey === "monthly_rent");
    const conflict = normalized.standardFields.find((row) => row.canonicalKey === "security_deposit");

    expect(rent.status).toBe("manually_edited");
    expect(conflict.status).toBe("needs_review");
    expect(normalized.expenseRules.find((row) => row.category === "real_estate_taxes")?.status).toBe("approved");
    expect(normalized.expenseRules.find((row) => row.category === "utilities")?.status).toBe("needs_review");
    expect(normalized.camRules.find((row) => row.category === "annual_reconciliation")?.status).toBe("approved");
    expect(normalized.camRules.find((row) => row.category === "true_up")?.status).toBe("needs_review");

    const { expenseRules, camRules } = splitRulesForLeaseReview(workflowRules);
    expect(expenseRules.map((rule) => rule.id)).toEqual(expect.arrayContaining(["accepted-tax", "utilities-review"]));
    expect(camRules.map((rule) => rule.id)).toEqual(expect.arrayContaining(["accepted-cam-reconciliation", "uncertain-true-up"]));

    expect(resolveBudgetPreviewInputs(lease)).toEqual({
      monthly: 13000,
      startBasis: "2026-03-01",
      escalationRate: 3,
    });
  });

  it("preserves reviewer-approved values during automated extraction refresh", () => {
    const extractionData = {
      fields: {
        monthly_rent: { value: 13000, source_page: 4, source_text: "Reviewer-confirmed sanitized clause.", manually_edited: true },
        lease_type: { value: "nnn", source_page: 5, source_text: "Sanitized NNN clause." },
      },
      field_reviews: {
        monthly_rent: { status: "edited", value: 13000 },
        lease_type: { status: "accepted" },
      },
    };

    const { nextExtraction, protectedFieldsPreservedCount } = mergeLatestExtraction({
      extractionData,
      fieldsWithEvidence: {
        monthly_rent: { value: 99999, source_page: 4, source_text: "Automated refresh stale rent." },
        lease_type: { value: "gross", source_page: 5, source_text: "Automated refresh stale lease type." },
        expiration_date: { value: "2031-12-31", source_page: 3, source_text: "Sanitized expiration clause." },
      },
      evidenceMap: {},
      confidenceMap: {},
    });

    expect(protectedFieldsPreservedCount).toBe(2);
    expect(nextExtraction.fields.monthly_rent.value).toBe(13000);
    expect(nextExtraction.fields.lease_type.value).toBe("nnn");
    expect(nextExtraction.fields.expiration_date.value).toBe("2031-12-31");
    expect(nextExtraction.field_reviews).toEqual(extractionData.field_reviews);
  });

  it("keeps assignment and amendment reviews profile-aware instead of inheriting full base-lease blockers", () => {
    const assignment = normalizeLeaseReviewData(leaseFixture({
      profile: "assignment",
      fields: {
        assignee_name: extracted("New Tenant LLC", 1),
        assignment_effective_date: extracted("2026-05-01", 1),
      },
      rules: [],
    }));

    const amendment = normalizeLeaseReviewData(leaseFixture({
      profile: "amendment",
      fields: {
        commencement_date: extracted("2026-06-01", 2),
        all_other_terms_remain_same: extracted(true, 2),
      },
      rules: [],
    }));

    for (const result of [assignment, amendment]) {
      expect(result.currentReviewPolicy.applyBaseLeaseBlockers).toBe(false);
      expect(result.readinessSummary.missingRequiredFields).not.toContain("monthly_rent");
      expect(result.approvalBlockers.budgetBlockers).toEqual([]);
      expect(result.approvalBlockers.camBlockers).toEqual([]);
    }
  });
});
