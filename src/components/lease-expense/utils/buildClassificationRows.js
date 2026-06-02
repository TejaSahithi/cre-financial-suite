import { leaseExpenseRuleService } from "@/services/leaseExpenseRuleService";
import { expenseService } from "@/services/expenseService";
import { resolveTenantForExpense } from "@/lib/tenantResolver";

export function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

export function humanize(value) {
  const text = String(value || "").replace(/[_-]+/g, " ").trim();
  if (!text) return "-";
  return text.replace(/\b\w/g, (char) => char.toUpperCase());
}

export function toNumber(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

export function buildAmountBuckets(amount, recoverabilityResult) {
  const numericAmount = toNumber(amount);
  return {
    recoverable_amount: recoverabilityResult === "recoverable" ? numericAmount : 0,
    non_recoverable_amount: recoverabilityResult === "non_recoverable" ? numericAmount : 0,
    conditional_amount: recoverabilityResult === "conditional" ? numericAmount : 0,
    excluded_amount: recoverabilityResult === "excluded" ? numericAmount : 0,
  };
}

export function leaseCoversYear(lease, fiscalYear) {
  if (!fiscalYear || fiscalYear === "all") return true;

  const start = lease?.start_date ? new Date(`${lease.start_date}T00:00:00`) : null;
  const end = lease?.end_date ? new Date(`${lease.end_date}T23:59:59`) : null;
  const yearStart = new Date(Number(fiscalYear), 0, 1);
  const yearEnd = new Date(Number(fiscalYear), 11, 31, 23, 59, 59);

  if (start && Number.isNaN(start.getTime())) return true;
  if (end && Number.isNaN(end.getTime())) return true;
  if (start && start > yearEnd) return false;
  if (end && end < yearStart) return false;
  return true;
}

export function isClassificationSentToCam(record = {}) {
  return Boolean(
    record?.sent_to_cam ||
    normalizeText(record?.cam_status) === "sent" ||
    normalizeText(record?.cam_status) === "cam_ready" ||
    record?.sent_to_cam_at ||
    normalizeText(record?.next_step) === "sent to cam"
  );
}

export function classificationRecordTime(record = {}) {
  return Date.parse(
    record?.sent_to_cam_at ||
    record?.updated_at ||
    record?.classified_at ||
    record?.reviewed_at ||
    record?.finalized_at ||
    ""
  );
}

export function preferClassificationRecord(current, candidate) {
  if (!current) return candidate;
  if (!candidate) return current;

  const currentSent = isClassificationSentToCam(current);
  const candidateSent = isClassificationSentToCam(candidate);
  if (currentSent !== candidateSent) {
    return candidateSent ? candidate : current;
  }

  const currentTime = classificationRecordTime(current);
  const candidateTime = classificationRecordTime(candidate);
  if (!Number.isFinite(currentTime)) return candidate;
  if (!Number.isFinite(candidateTime)) return current;
  return candidateTime >= currentTime ? candidate : current;
}

export function getCamDecision(row) {
  const camStatus = normalizeText(row.camStatus || row.classificationRecord?.cam_status);
  if (camStatus === "cam_ready") {
    return { label: "CAM Ready", why: "This row is approved for CAM calculation." };
  }

  if (row.rowType === "rule_missing_actual") {
    if (row.rule?.published_to_cam) {
      return { label: "Needs Review", why: "The approved lease rule is published, but CAM needs either an actual expense or a reviewed rule amount." };
    }
    return { label: "Needs Review", why: "The lease rule exists, but no CAM rule amount or actual expense has been reviewed yet." };
  }

  if (row.rowType === "actual_missing_rule") {
    return { label: "Needs Review", why: "This actual expense is unmatched. A reviewer can send it to CAM with a reason unless an explicit lease rule excludes it." };
  }

  // Matched Classification
  if (row.sentToCam) {
    return { label: "CAM Ready", why: "This finalized recoverable expense is ready for CAM calculation." };
  }

  const paymentTreatment = normalizeText(row.rule?.payment_treatment);
  if (
    row.recoverabilityResult === "non_recoverable" ||
    row.recoverabilityResult === "excluded" ||
    (Boolean(row.rule) && row.camEligible === "no") ||
    paymentTreatment === "included_in_base_rent" ||
    paymentTreatment === "tenant_direct_contract" ||
    row.rule?.is_excluded
  ) {
    return { label: "Excluded", why: "An approved lease rule explicitly excludes this expense from CAM." };
  }

  if (row.classificationStatus !== "finalized" || row.recoverabilityResult === "conditional" || row.recoverabilityResult === "needs_review") {
    return { label: "Needs Review", why: "This row is conditional, unfinalized, or missing required CAM allocation details." };
  }

  return { label: "Eligible", why: "Finalized recoverable expense matched to an approved CAM-eligible lease rule." };
}

export function hasExplicitCamExclusion(row) {
  const paymentTreatment = normalizeText(row?.rule?.payment_treatment);
  const hasRule = Boolean(row?.rule || row?.leaseExpenseRuleId);
  return row?.recoverabilityResult === "non_recoverable" ||
    row?.recoverabilityResult === "excluded" ||
    (hasRule && row?.camEligible === "no") ||
    Boolean(row?.rule?.included_in_base_rent) ||
    paymentTreatment === "included_in_base_rent" ||
    paymentTreatment === "tenant_direct_contract" ||
    Boolean(row?.rule?.is_excluded);
}

export function isAutomaticCamReadyRow(row) {
  return Boolean(
    row?.actualExpenseId &&
    row?.rowType === "matched_classification" &&
    row?.classificationStatus === "finalized" &&
    row?.recoverabilityResult === "recoverable" &&
    row?.camEligible === "yes" &&
    row?.rule?.published_to_cam === true &&
    row?.amount > 0 &&
    !hasExplicitCamExclusion(row)
  );
}

export function buildClassificationRows({
  approvedActuals,
  approvedRules,
  existingClassifications,
  scopedLeases,
  leases,
  leaseById,
  propertyById,
  buildingById,
  unitById,
  tenantById,
  scopeYear
}) {
  const result = [];
  const classificationByExpenseId = new Map();
  const classificationByRuleId = new Map();
  const approvedRuleById = new Map(approvedRules.map((rule) => [rule.id, rule]));
  const rulesByLeaseId = new Map();
  const usedRuleIds = new Set();
  const candidateLeases = scopedLeases.length > 0 ? scopedLeases : leases.filter((lease) => leaseCoversYear(lease, scopeYear));

  for (const classification of existingClassifications) {
    const expenseId = classification.expense_id || classification.actual_expense_id;
    if (expenseId) {
      const existing = classificationByExpenseId.get(expenseId) || null;
      classificationByExpenseId.set(expenseId, preferClassificationRecord(existing, classification));
    }
    if (classification.row_type === "rule_missing_actual" && classification.lease_expense_rule_id) {
      const existingByRule = classificationByRuleId.get(classification.lease_expense_rule_id) || null;
      classificationByRuleId.set(
        classification.lease_expense_rule_id,
        preferClassificationRecord(existingByRule, classification)
      );
    }
  }

  for (const rule of approvedRules) {
    const leaseId = rule.rule_set?.lease_id || rule.lease_id;
    const list = rulesByLeaseId.get(leaseId) || [];
    list.push(rule);
    rulesByLeaseId.set(leaseId, list);
  }

  for (const expense of approvedActuals) {
    const classificationRecord = classificationByExpenseId.get(expense.id) || null;
    const persistedRuleId =
      classificationRecord?.lease_expense_rule_id ||
      classificationRecord?.linked_expense_rule_id ||
      classificationRecord?.recovery_rule_id ||
      expense.linked_expense_rule_id ||
      expense.recovery_rule_id ||
      null;
    let matchedRule = persistedRuleId ? approvedRuleById.get(persistedRuleId) || null : null;
    let matchedLease = matchedRule ? leaseById.get(matchedRule.lease_id || matchedRule.rule_set?.lease_id) || null : null;
    let match = null;

    if (!matchedRule) {
      match = expenseService.matchActualExpenseToLeaseRule(expense, {
        leases: candidateLeases,
        rulesByLeaseId,
      });
      matchedRule = match?.rule || null;
      matchedLease = match?.lease || matchedLease;
    }

    const actualAmount = toNumber(expense.amount);
    const hasMatchedRule = Boolean(matchedRule);
    if (matchedRule?.id) usedRuleIds.add(matchedRule.id);

    const recoverabilityResult = hasMatchedRule
      ? normalizeText(
        classificationRecord?.recoverability_result ||
        classificationRecord?.recovery_status ||
        expense.recoverability_result ||
        expense.recovery_status ||
        match?.recoverability_result ||
        "needs_review"
      )
      : "needs_review";
    const classificationStatus = hasMatchedRule
      ? normalizeText(
        classificationRecord?.classification_status ||
        (recoverabilityResult === "conditional"
          ? "conditional"
          : recoverabilityResult === "excluded" || recoverabilityResult === "non_recoverable"
            ? "excluded"
            : "matched")
      )
      : "unmatched";
    const exceptionType = hasMatchedRule
      ? classificationRecord?.exception_type || null
      : "no_matching_rule";
    const camEligible = hasMatchedRule
      ? normalizeText(
        classificationRecord?.cam_eligible ||
        leaseExpenseRuleService.getCamEligibleDecision(matchedRule) ||
        "needs_review"
      )
      : normalizeText(classificationRecord?.cam_eligible || expense.cam_eligible || "needs_review");
    const amountBuckets = hasMatchedRule
      ? {
        recoverable_amount: toNumber(classificationRecord?.recoverable_amount),
        non_recoverable_amount: toNumber(classificationRecord?.non_recoverable_amount),
        conditional_amount: toNumber(classificationRecord?.conditional_amount),
        excluded_amount: toNumber(classificationRecord?.excluded_amount),
      }
      : buildAmountBuckets(0, "needs_review");
    const lease = matchedLease || (expense.lease_id ? leaseById.get(expense.lease_id) || null : null);
    const property = propertyById.get(expense.property_id || lease?.property_id) || null;
    const building = buildingById.get(expense.building_id || lease?.building_id) || null;
    const unit = unitById.get(expense.unit_id || lease?.unit_id) || null;
    const sentToCam = isClassificationSentToCam(classificationRecord);
    const camStatus = normalizeText(
      classificationRecord?.cam_status ||
      (sentToCam ? "cam_ready" : hasMatchedRule ? null : "needs_review")
    );

    const row = {
      id: classificationRecord?.id || `${expense.id}:${matchedRule?.id || "unmatched"}`,
      rowType: hasMatchedRule ? "matched_classification" : "actual_missing_rule",
      actualExpenseId: expense.id,
      leaseExpenseRuleId: matchedRule?.id || null,
      classificationRecord,
      expense,
      rule: matchedRule,
      lease,
      property,
      building,
      unit,
      expenseDate: expense.expense_date || expense.date || expense.service_period_start || null,
      vendor: expense.vendor || expense.vendor_name || "-",
      ...(() => {
        const resolution = resolveTenantForExpense(expense, {
          leases,
          leaseById,
          unitById,
          tenantById,
        });
        return {
          tenantLabel: resolution.tenant?.name || "-",
          tenantResolution: resolution,
        };
      })(),
      ruleLabel: matchedRule
        ? `${matchedRule.expense_category || matchedRule.category_name || "-"}${matchedRule.expense_subcategory ? ` / ${matchedRule.expense_subcategory}` : ""}`
        : "-",
      amount: actualAmount,
      financialAmount: actualAmount,
      recoverabilityResult: recoverabilityResult || "needs_review",
      classificationStatus,
      exceptionType,
      camEligible,
      camStatus,
      recoverableAmount: hasMatchedRule ? (amountBuckets.recoverable_amount || (recoverabilityResult === "recoverable" ? actualAmount : 0)) : 0,
      nonRecoverableAmount: hasMatchedRule ? (amountBuckets.non_recoverable_amount || (recoverabilityResult === "non_recoverable" ? actualAmount : 0)) : 0,
      conditionalAmount: hasMatchedRule ? (amountBuckets.conditional_amount || (recoverabilityResult === "conditional" ? actualAmount : 0)) : 0,
      excludedAmount: hasMatchedRule ? (amountBuckets.excluded_amount || (recoverabilityResult === "excluded" ? actualAmount : 0)) : 0,
      sentToCam,
      nextStep:
        (camStatus === "cam_ready" ? "CAM Ready" : classificationRecord?.next_step) ||
        (hasMatchedRule
          ? (
            classificationStatus === "finalized"
              ? (camEligible === "yes" && recoverabilityResult === "recoverable" && matchedRule?.published_to_cam === true ? "CAM Ready" : "Needs Review")
              : "Finalize row"
          )
          : "Needs Review"),
      message: hasMatchedRule
        ? (
          classificationRecord?.recovery_reason ||
          expense.recovery_reason ||
          match?.reason ||
          "Approved actual expense matched to an approved lease expense rule."
        )
        : "No approved lease expense rule matched this actual expense for the selected scope and period.",
    };

    row.canFinalize =
      row.classificationStatus !== "finalized" &&
      (
        (row.rowType === "matched_classification" && Boolean(row.actualExpenseId)) ||
        (row.rowType === "rule_missing_actual" && row.amount != null && Number(row.amount) > 0)
      );
    row.canSendToReview =
      Boolean(row.actualExpenseId) &&
      (row.rowType === "actual_missing_rule" ||
        row.recoverabilityResult === "needs_review" ||
        ["unmatched", "exception", "conditional"].includes(row.classificationStatus));
    row.canSendToCam =
      Boolean(row.actualExpenseId) &&
      row.amount > 0 &&
      !row.sentToCam &&
      (
        isAutomaticCamReadyRow(row) ||
        (
          ["actual_missing_rule", "matched_classification"].includes(row.rowType) &&
          !hasExplicitCamExclusion(row)
        )
      );

    const decisionObj = getCamDecision(row);
    row.camDecision = decisionObj.label;
    row.camWhy = decisionObj.why;
    result.push(row);
  }

  for (const rule of approvedRules) {
    if (usedRuleIds.has(rule.id)) continue;
    const lease = leaseById.get(rule.rule_set?.lease_id || rule.lease_id) || null;
    const property = propertyById.get(rule.property_id || rule.rule_set?.property_id || lease?.property_id) || null;
    const building = buildingById.get(rule.building_id || lease?.building_id) || null;
    const unit = unitById.get(rule.unit_id || lease?.unit_id) || null;

    const c = classificationByRuleId.get(rule.id) || null;

    const gapRow = {
      id: c?.id || `coverage-gap:${rule.id}`,
      rowType: "rule_missing_actual",
      actualExpenseId: null,
      leaseExpenseRuleId: rule.id,
      classificationRecord: c,
      expense: null,
      rule,
      lease,
      property,
      building,
      unit,
      expenseDate: null,
      vendor: "-",
      tenantLabel: lease?.tenant_name || "-",
      tenantResolution: lease?.tenant_name
        ? { tenant: { id: lease.tenant_id || null, name: lease.tenant_name }, source: "matched_lease", reason: null, lease, unit, reasonText: null }
        : { tenant: null, source: "unresolved", reason: "lease_missing_tenant_id", lease, unit, reasonText: "Matched lease has no tenant_id." },
      ruleLabel: `${rule.expense_category || rule.category_name || "-"}${rule.expense_subcategory ? ` / ${rule.expense_subcategory}` : ""}`,
      amount: c?.amount != null ? Number(c.amount) : null,
      financialAmount: c?.amount != null ? Number(c.financial_amount || c.amount || 0) : 0,
      recoverabilityResult: normalizeText(c?.recoverability_result || c?.recovery_status || leaseExpenseRuleService.getRecoverableDecision(rule)) === "yes"
        ? "recoverable"
        : normalizeText(leaseExpenseRuleService.getRecoverableDecision(rule)) || "needs_review",
      classificationStatus: c?.classification_status || "coverage_gap",
      exceptionType: c?.exception_type || null,
      camEligible: c?.cam_eligible || leaseExpenseRuleService.getCamEligibleDecision(rule) || "no",
      camStatus: normalizeText(c?.cam_status || (isClassificationSentToCam(c) ? "cam_ready" : "needs_review")),
      recoverableAmount: c?.amount != null && normalizeText(c?.recoverability_result || leaseExpenseRuleService.getRecoverableDecision(rule)) === "recoverable" ? Number(c.amount) : 0,
      nonRecoverableAmount: c?.amount != null && normalizeText(c?.recoverability_result || leaseExpenseRuleService.getRecoverableDecision(rule)) === "non_recoverable" ? Number(c.amount) : 0,
      conditionalAmount: c?.amount != null && normalizeText(c?.recoverability_result || leaseExpenseRuleService.getRecoverableDecision(rule)) === "conditional" ? Number(c.amount) : 0,
      excludedAmount: c?.amount != null && normalizeText(c?.recoverability_result || leaseExpenseRuleService.getRecoverableDecision(rule)) === "excluded" ? Number(c.amount) : 0,
      sentToCam: isClassificationSentToCam(c),
      nextStep: isClassificationSentToCam(c) ? "CAM Ready" : (c?.next_step || "Provide CAM rule amount"),
      message: "Approved lease rule exists, but no actual expense found for this period.",
      canFinalize: false,
      canSendToReview: false,
      canSendToCam: false,
    };

    gapRow.canFinalize = gapRow.amount != null && Number(gapRow.amount) > 0 && gapRow.classificationStatus !== "finalized";

    const decisionObj = getCamDecision(gapRow);
    gapRow.camDecision = decisionObj.label;
    gapRow.camWhy = decisionObj.why;
    
    result.push(gapRow);
  }

  return result;
}
