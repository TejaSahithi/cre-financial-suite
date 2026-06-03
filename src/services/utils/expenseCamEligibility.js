import { leaseExpenseRuleService } from "@/services/leaseExpenseRuleService";
import { normalizeText, toNumber } from "./expenseParsers";

export function isClassificationSentToCam(classification = {}) {
  const camStatus = normalizeText(classification?.cam_status);
  return Boolean(
    classification?.sent_to_cam ||
    classification?.sent_to_cam_at ||
    camStatus === "sent" ||
    normalizeText(classification?.next_step) === "sent to cam"
  );
}

export function hasExplicitCamExclusion({ classification = {}, expense = {}, rule = null } = {}) {
  const recoverability = normalizeText(
    rule
      ? leaseExpenseRuleService.getRecoverableDecision(rule)
      : classification?.recoverability_result ||
      classification?.recovery_status ||
      expense?.recoverability_result ||
      expense?.recovery_status
  );
  const camEligible = normalizeText(
    rule
      ? leaseExpenseRuleService.getCamEligibleDecision(rule)
      : classification?.cam_eligible ||
      expense?.cam_eligible
  );
  const paymentTreatment = normalizeText(leaseExpenseRuleService.getPaymentTreatment(rule));

  return recoverability === "no" ||
    recoverability === "non_recoverable" ||
    recoverability === "excluded" ||
    (Boolean(rule) && camEligible === "no") ||
    Boolean(rule?.included_in_base_rent) ||
    paymentTreatment === "included_in_base_rent" ||
    paymentTreatment === "tenant_direct_contract" ||
    Boolean(rule?.is_excluded) ||
    Boolean(classification?.exclusion_applied);
}

export function canSendClassificationToCam({ classification, expense, rule, manualReason = "" }) {
  const amount = toNumber(classification?.amount ?? expense?.amount);
  const recoverabilityResult = normalizeText(classification?.recoverability_result || classification?.recovery_status);
  const camEligible = normalizeText(classification?.cam_eligible);
  const paymentTreatment = normalizeText(leaseExpenseRuleService.getPaymentTreatment(rule));
  const hasActual = Boolean(classification?.actual_expense_id || classification?.expense_id);
  const hasRule = Boolean(classification?.lease_expense_rule_id || classification?.linked_expense_rule_id);
  const hasManualReason = Boolean(String(manualReason || "").trim());
  const explicitExclusion = hasExplicitCamExclusion({ classification, expense, rule });

  const automaticActualPath =
    hasActual &&
    hasRule &&
    recoverabilityResult === "recoverable" &&
    camEligible === "yes" &&
    rule?.published_to_cam === true &&
    amount > 0 &&
    !isClassificationSentToCam(classification) &&
    paymentTreatment !== "included_in_base_rent" &&
    paymentTreatment !== "tenant_direct_contract";

  const manualActualPath =
    hasActual &&
    hasManualReason &&
    amount > 0 &&
    !isClassificationSentToCam(classification) &&
    !explicitExclusion;

  return automaticActualPath || manualActualPath;
}
