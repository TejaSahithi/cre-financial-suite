import { describe, expect, it } from "vitest";
import {
  deriveCamEligibility,
  deriveExclusionDecision,
  derivePublishToCamEligibility,
  deriveRecoverabilityDecision,
  deriveRuleDecision,
  deriveRuleSetStatus,
  getRuleCamExclusionReason,
  getRuleClassificationExclusionReason,
} from "./ruleDecisionEngine";

const approvedCamRule = {
  id: "rule-1",
  expense_category: "common_area_maintenance",
  payment_treatment: "reimbursable",
  recoverable_from_tenant: "yes",
  cam_eligible: "yes",
  approval_status: "approved",
  review_status: "approved",
  exact_source_text: "Tenant shall pay its pro rata share of Common Area Maintenance expenses.",
};

describe("ruleDecisionEngine", () => {
  it("derives approved rule decisions from one canonical path", () => {
    const decision = deriveRuleDecision(approvedCamRule);

    expect(decision.status).toBe("approved");
    expect(decision.recoverability).toBe("recoverable");
    expect(decision.exclusion).toBe("included");
    expect(decision.camEligibility).toBe("eligible");
    expect(decision.publishToCamEligibility).toBe("eligible");
  });

  it("derives rejected and needs_review rule statuses", () => {
    expect(deriveRuleDecision({
      ...approvedCamRule,
      approval_status: "rejected",
      review_status: "rejected",
    }).status).toBe("rejected");

    expect(deriveRuleDecision({
      ...approvedCamRule,
      approval_status: "needs_review",
      review_status: "needs_review",
    }).status).toBe("needs_review");
  });

  it("treats explicit approved exclusions as not_applicable", () => {
    const decision = deriveRuleDecision({
      ...approvedCamRule,
      is_excluded: true,
      payment_treatment: "not_applicable",
      recoverable_from_tenant: "no",
      cam_eligible: "no",
    });

    expect(decision.status).toBe("not_applicable");
    expect(deriveExclusionDecision({
      ...approvedCamRule,
      is_excluded: true,
      payment_treatment: "not_applicable",
      recoverable_from_tenant: "no",
      cam_eligible: "no",
    })).toBe("not_applicable");
  });

  it("does not let a raw cam_eligible:'no' silently exclude a base-year tax escalation with a real share/formula", () => {
    // Regression: an extracted rule for "Tenant pays 70% of the increase in
    // combined ... real estate taxes over the 2026 calendar-year base taxes"
    // had payment_treatment=reimbursable, recoverable_from_tenant=yes,
    // tenant_share_percent=70, but cam_eligible explicitly stamped "no" --
    // trusting that flag verbatim made an obviously CAM-participating
    // clause show as "N/A" (not_eligible). Confirmed policy: base-year
    // escalations DO participate in CAM even though they're computed
    // per-lease rather than via a building-wide pooled formula.
    const baseYearTaxEscalation = {
      id: "rule-tax-escalation",
      expense_category: "real_estate_taxes",
      expense_subcategory: "tax_escalation",
      payment_treatment: "reimbursable",
      recoverable_from_tenant: "yes",
      is_recoverable: true,
      recovery_method: "base_year",
      tenant_share_percent: "70",
      allocation_basis: "70% of increase over stated base taxes",
      cam_eligible: "no",
      review_status: "needs_review",
      approval_status: "draft",
      exact_source_text: "Tenant pays 70% of the increase in combined city, county, school, and special-district real estate taxes over the 2026 calendar-year base taxes of $38,400.00.",
    };

    expect(deriveCamEligibility(baseYearTaxEscalation)).toBe("conditional");
    expect(deriveRuleDecision(baseYearTaxEscalation).camEligibility).toBe("conditional");
  });

  it("still trusts cam_eligible:'no' when there is no pooled/reimbursable treatment or stated formula behind it", () => {
    // The override above is narrow: a plain not-recoverable/no-formula rule
    // with cam_eligible:"no" must still resolve to not_eligible, not get
    // swept into "conditional" just because cam_eligible happens to be "no".
    expect(deriveCamEligibility({
      payment_treatment: "tenant_direct_contract",
      recoverable_from_tenant: "no",
      cam_eligible: "no",
    })).toBe("not_eligible");

    expect(deriveCamEligibility({
      payment_treatment: "reimbursable",
      recoverable_from_tenant: "yes",
      cam_eligible: "no",
      // no tenant_share_percent/allocation_basis/formula at all
    })).toBe("not_eligible");
  });

  it("blocks publish when mapping or lease evidence is missing", () => {
    const eligibility = derivePublishToCamEligibility({
      ...approvedCamRule,
      expense_category: "",
      category_name: "",
      exact_source_text: "",
      source_type: "deterministic_template",
      generation_source: "template_checklist",
    });

    expect(eligibility.status).toBe("blocked");
    expect(eligibility.blockingReasons).toContain("weak_fallback");
    expect(getRuleClassificationExclusionReason({
      ...approvedCamRule,
      expense_category: "",
      category_name: "",
    })).toBe("missing_category");
  });

  it("marks already published rules separately from eligible publish attempts", () => {
    const eligibility = derivePublishToCamEligibility({
      ...approvedCamRule,
      published_to_cam: true,
    });

    expect(eligibility.status).toBe("already_published");
    expect(getRuleCamExclusionReason({
      ...approvedCamRule,
      published_to_cam: true,
    })).toBe(null);
  });

  it("returns canonical recoverability and CAM decisions", () => {
    expect(deriveRecoverabilityDecision({ recoverable_from_tenant: "yes" })).toBe("recoverable");
    expect(deriveRecoverabilityDecision({ recoverable_from_tenant: "no" })).toBe("not_recoverable");
    expect(deriveCamEligibility({
      expense_category: "utilities",
      recoverable_from_tenant: "yes",
    })).toBe("eligible");
    expect(deriveCamEligibility({
      payment_treatment: "tenant_direct_contract",
      recoverable_from_tenant: "yes",
      cam_eligible: "yes",
    })).toBe("not_eligible");
  });

  it("derives rule set status from active canonical decisions", () => {
    expect(deriveRuleSetStatus([
      approvedCamRule,
      { ...approvedCamRule, id: "rule-2", row_status: "not_applicable" },
    ])).toBe("approved");

    expect(deriveRuleSetStatus([
      approvedCamRule,
      { ...approvedCamRule, id: "rule-3", review_status: "needs_review", approval_status: "draft" },
    ])).toBe("needs_review");
  });
});
