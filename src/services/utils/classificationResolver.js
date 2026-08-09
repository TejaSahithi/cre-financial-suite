/**
 * classificationResolver.js
 *
 * Single authoritative expense classification resolver shared by UI and Send-to-CAM backend.
 * Evaluates actual expenses against canonical categories, scope, service period, explicit tenant links,
 * and applicable normalized lease recovery rules.
 *
 * Returns exactly ONE of 13 explicit status codes:
 *   1. READY_POOLED_CAM
 *   2. READY_DIRECT_RECOVERY
 *   3. DIRECT_BILL
 *   4. TENANT_DIRECT
 *   5. INCLUDED_IN_RENT
 *   6. NONRECOVERABLE
 *   7. CONDITIONAL_REVIEW
 *   8. NEEDS_CATEGORY
 *   9. NEEDS_SCOPE
 *  10. NEEDS_SERVICE_PERIOD
 *  11. NEEDS_TENANT
 *  12. POLICY_CONFLICT
 *  13. PUBLISHED
 */

import { deriveNormalizedContractModel } from "./ruleDecisionEngine";

export const CLASSIFICATION_STATUSES = {
  READY_POOLED_CAM: "READY_POOLED_CAM",
  READY_DIRECT_RECOVERY: "READY_DIRECT_RECOVERY",
  DIRECT_BILL: "DIRECT_BILL",
  TENANT_DIRECT: "TENANT_DIRECT",
  INCLUDED_IN_RENT: "INCLUDED_IN_RENT",
  NONRECOVERABLE: "NONRECOVERABLE",
  CONDITIONAL_REVIEW: "CONDITIONAL_REVIEW",
  NEEDS_CATEGORY: "NEEDS_CATEGORY",
  NEEDS_SCOPE: "NEEDS_SCOPE",
  NEEDS_SERVICE_PERIOD: "NEEDS_SERVICE_PERIOD",
  NEEDS_TENANT: "NEEDS_TENANT",
  POLICY_CONFLICT: "POLICY_CONFLICT",
  PUBLISHED: "PUBLISHED",
};

export function classifyExpense({
  expense = {},
  rules = [],
  scope = {},
  publicationStatus = null,
} = {}) {
  // 1. Check publication status first
  if (publicationStatus === "published" || expense?.publication_status === "published" || expense?.sent_to_cam) {
    return {
      status: CLASSIFICATION_STATUSES.PUBLISHED,
      label: "Published to CAM",
      description: "Classification has been published to CAM calculation inputs.",
      cam_eligible: true,
      route: "cam_inputs",
    };
  }

  // 2. Validate missing mandatory fields
  const expenseCategoryId = expense?.expense_category_id || expense?.category_id || expense?.canonical_category_id || null;
  if (!expenseCategoryId) {
    return {
      status: CLASSIFICATION_STATUSES.NEEDS_CATEGORY,
      label: "Needs Category",
      description: "Canonical expense_category_id is missing.",
      cam_eligible: false,
      route: "review_required",
    };
  }

  const propertyId = scope?.property_id || expense?.property_id || null;
  if (!propertyId) {
    return {
      status: CLASSIFICATION_STATUSES.NEEDS_SCOPE,
      label: "Needs Scope",
      description: "Property/building/unit scope validation failed.",
      cam_eligible: false,
      route: "review_required",
    };
  }

  const servicePeriodStart = expense?.service_period_start || expense?.period_start || expense?.date || null;
  const servicePeriodEnd = expense?.service_period_end || expense?.period_end || expense?.date || null;
  if (!servicePeriodStart || !servicePeriodEnd) {
    return {
      status: CLASSIFICATION_STATUSES.NEEDS_SERVICE_PERIOD,
      label: "Needs Service Period",
      description: "Service period start and end dates must be defined.",
      cam_eligible: false,
      route: "review_required",
    };
  }

  // 3. Filter matching approved recovery policies for category and effective period
  const matchingRules = (rules || []).filter((rule) => {
    const model = deriveNormalizedContractModel(rule);
    const catMatch = !model.expense_category_id || model.expense_category_id === expenseCategoryId;
    const statusOk = model.approval_status === "approved" || rule?.published_to_cam === true;
    return catMatch && statusOk;
  });

  // 4. Policy Conflict Guard: If multiple conditional/conflicting rules match, do NOT use arbitrary highest-score guess!
  const conditionalRules = matchingRules.filter((r) => {
    const m = deriveNormalizedContractModel(r);
    return m.recovery_treatment === "conditional" || m.condition_type != null;
  });

  if (conditionalRules.length > 1) {
    const treatments = new Set(conditionalRules.map((r) => deriveNormalizedContractModel(r).recovery_treatment));
    if (treatments.size > 1) {
      return {
        status: CLASSIFICATION_STATUSES.POLICY_CONFLICT,
        label: "Policy Conflict",
        description: `Multiple matching conditional policies specify conflicting treatments (${Array.from(treatments).join(", ")}).`,
        cam_eligible: false,
        route: "review_required",
      };
    }
  }

  // 5. Evaluate matching rule or fallback to standard pooled recovery
  const primaryRule = matchingRules[0] ? deriveNormalizedContractModel(matchingRules[0]) : null;

  if (primaryRule) {
    const treatment = primaryRule.recovery_treatment;

    if (treatment === "conditional" || primaryRule.condition_type != null) {
      return {
        status: CLASSIFICATION_STATUSES.CONDITIONAL_REVIEW,
        label: "Conditional Review",
        description: `Recovery condition (${primaryRule.condition_type || "unresolved"}) requires review before CAM publication.`,
        cam_eligible: false,
        route: "review_required",
      };
    }

    if (treatment === "tenant_direct") {
      return {
        status: CLASSIFICATION_STATUSES.TENANT_DIRECT,
        label: "Tenant Direct",
        description: "Obligation is paid directly by tenant under direct contract.",
        cam_eligible: false,
        route: "outside_cam",
      };
    }

    if (treatment === "included_in_rent") {
      return {
        status: CLASSIFICATION_STATUSES.INCLUDED_IN_RENT,
        label: "Included in Rent",
        description: "Expense is covered by gross base rent and excluded from CAM recovery.",
        cam_eligible: false,
        route: "outside_cam",
      };
    }

    if (treatment === "nonrecoverable") {
      return {
        status: CLASSIFICATION_STATUSES.NONRECOVERABLE,
        label: "Non-Recoverable",
        description: "Expense is explicitly non-recoverable under lease contract.",
        cam_eligible: false,
        route: "outside_cam",
      };
    }

    if (treatment === "direct_bill") {
      const leaseId = expense?.lease_id || scope?.lease_id || primaryRule.scope === "tenant" ? scope?.lease_id : null;
      if (!leaseId) {
        return {
          status: CLASSIFICATION_STATUSES.NEEDS_TENANT,
          label: "Needs Tenant",
          description: "Direct bill treatment requires an explicit tenant/lease link.",
          cam_eligible: false,
          route: "review_required",
        };
      }
      return {
        status: CLASSIFICATION_STATUSES.DIRECT_BILL,
        label: "Direct Bill",
        description: "Expense is billed directly to the tenant.",
        cam_eligible: false,
        route: "outside_cam",
      };
    }

    if (treatment === "direct_recovery") {
      const leaseId = expense?.lease_id || scope?.lease_id || null;
      if (!leaseId) {
        return {
          status: CLASSIFICATION_STATUSES.NEEDS_TENANT,
          label: "Needs Tenant",
          description: "Direct recovery treatment requires an explicit tenant/lease link.",
          cam_eligible: false,
          route: "review_required",
        };
      }
      return {
        status: CLASSIFICATION_STATUSES.READY_DIRECT_RECOVERY,
        label: "Ready Direct Recovery",
        description: "Approved direct recovery expense linked to specific tenant/lease.",
        cam_eligible: true,
        route: "direct_cam_input",
      };
    }
  }

  // 6. Default Pooled CAM: Pooled actuals do not require individual tenant policies unless a tenant-specific direct recovery policy applies.
  return {
    status: CLASSIFICATION_STATUSES.READY_POOLED_CAM,
    label: "Ready Pooled CAM",
    description: "Property/building pooled operating expense ready for CAM pool allocation.",
    cam_eligible: true,
    route: "pooled_cam_input",
  };
}
