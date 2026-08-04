/**
 * camPolicySummary — pure, read-only derivation of a business-friendly
 * policy summary from a materialized lease_recovery_policy row and its
 * lease_recovery_policy_steps. Never invents or alters a value: every field
 * either comes directly from an approved policy step's parameters, or is
 * explicitly reported as not configured. This module does not calculate
 * anything the engine doesn't already calculate -- it only reads and labels
 * what a materialized policy already contains.
 */
import {
  recoveryMethodLabel, allocationBasisLabel, capTypeLabel,
} from "@/lib/camLabels";

function findStep(steps, type) {
  return (steps || []).find((s) => s.step_type === type) || null;
}
function findCategoryStep(steps) {
  return (steps || []).find((s) => s.expense_category_id) || null;
}

/**
 * @param {object} policy - a lease_recovery_policies row
 * @param {object[]} steps - that policy's lease_recovery_policy_steps rows
 * @param {Map<string,string>} categoryNamesById - expense_categories.id -> category_name
 * @returns {object} a flat, display-ready summary
 */
export function summarizePolicy(policy, steps, categoryNamesById) {
  const categoryStep = findCategoryStep(steps);
  const shareStep = findStep(steps, "CALCULATE_SHARE");
  const directStep = findStep(steps, "DIRECT_ASSIGN");
  const grossUpStep = findStep(steps, "GROSS_UP_VARIABLE");
  const baseYearStep = findStep(steps, "APPLY_BASE_YEAR");
  const stopStep = findStep(steps, "APPLY_EXPENSE_STOP");
  const capStep = findStep(steps, "APPLY_CAP");
  const floorStep = findStep(steps, "APPLY_FLOOR");
  const deductibleStep = findStep(steps, "APPLY_DEDUCTIBLE");
  const feeStep = findStep(steps, "ADD_ADMIN_FEE") || findStep(steps, "ADD_MANAGEMENT_FEE");

  const categoryId = categoryStep?.expense_category_id || null;
  const categoryName = categoryId ? (categoryNamesById?.get(categoryId) ?? null) : null;

  let shareDescription = "Not configured";
  let numeratorDenominatorSource = "—";
  if (directStep) {
    shareDescription = "Direct Charge (fixed annual amount, not area-based)";
    numeratorDenominatorSource = "N/A — direct charge";
  } else if (shareStep) {
    const params = shareStep.parameters || {};
    if (params.recovery_method === "fixed_percentage" && params.tenant_share_percent != null) {
      shareDescription = `Fixed Contractual Share: ${params.tenant_share_percent}%`;
      numeratorDenominatorSource = "Contractual percentage on the lease — not area-derived";
    } else {
      shareDescription = recoveryMethodLabel(params.recovery_method || "pro_rata_share");
      numeratorDenominatorSource = `Numerator: lease's recovery area (lease premises area periods) — Denominator: ${allocationBasisLabel(params.allocation_basis || "rentable_area")} of the pool's scope`;
    }
  }

  return {
    policyId: policy.id,
    leaseId: policy.lease_id,
    categoryId,
    categoryName: categoryName ?? (categoryId ? "Category on file (name unavailable)" : null),
    hasCategory: Boolean(categoryId),
    shareDescription,
    numeratorDenominatorSource,
    grossUpTarget: grossUpStep ? `${grossUpStep.parameters?.target_occupancy_pct ?? "—"}% target occupancy` : "Not grossed up",
    baseYear: baseYearStep
      ? `Base year ${baseYearStep.parameters?.base_year ?? "—"}${baseYearStep.parameters?.base_year_amount != null ? ` — $${Number(baseYearStep.parameters.base_year_amount).toLocaleString()}` : ""}`
      : "None",
    expenseStop: stopStep ? `$${Number(stopStep.parameters?.expense_stop_amount ?? 0).toLocaleString()}/yr` : "None",
    cap: capStep
      ? `${capTypeLabel(capStep.parameters?.cap_type)}${capStep.parameters?.cap_amount != null ? ` — $${Number(capStep.parameters.cap_amount).toLocaleString()}` : ""}${capStep.parameters?.cap_percent != null ? ` — ${capStep.parameters.cap_percent}%/yr` : ""}`
      : "None",
    floor: floorStep ? `Floor configured (see step evidence)` : "Not configured",
    deductible: deductibleStep ? `Deductible configured (see step evidence)` : "Not configured",
    adminFee: feeStep ? `${feeStep.parameters?.admin_fee_percent ?? feeStep.parameters?.management_fee_percent ?? "—"}%` : "None",
    effectiveFrom: policy.effective_from,
    effectiveTo: policy.effective_to,
    sourceEvidence: policy.source_evidence || categoryStep?.source_evidence || null,
    status: policy.status,
    stepCount: (steps || []).length,
  };
}
