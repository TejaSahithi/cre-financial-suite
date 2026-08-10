import { leaseExpenseRuleService } from "@/services/leaseExpenseRuleService";
import { expenseService } from "@/services/expenseService";
import { resolveTenantForExpense, ruleRequiresPerTenantAllocation } from "@/lib/tenantResolver";
import { approvedLeaseFieldValue } from "@/lib/approvedLeaseSnapshot";
import {
  derivePaymentTreatment,
  deriveRuleDecision,
  deriveNormalizedContractModel,
  getRuleCamExclusionReason,
} from "@/services/utils/ruleDecisionEngine";

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

export function getCamDecision(row, options = {}) {
  const decision = getCamInputDecision(row, options);
  if (decision.state === "published_to_cam") {
    return { label: "Published to CAM", why: "A published cam_expense_inputs row exists for this classification." };
  }
  if (decision.state === "ready_to_send") {
    return { label: "Ready to Send to CAM", why: "The authoritative classification is finalized, recoverable, and CAM eligible." };
  }
  if (decision.state === "not_cam_eligible") {
    return { label: "Excluded", why: "The authoritative expense classification keeps this row out of CAM." };
  }
  if (decision.state === "conditional_review_required") {
    return { label: "Needs Review", why: "The classification is conditional and must be resolved before CAM." };
  }
  return { label: decision.label, why: "The authoritative classification decision is not ready for CAM publication." };
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

export function getLinkedRuleCamBlocker(row) {
  if (!row?.rule) return null;
  const reason = getRuleCamExclusionReason(row.rule, { scopeMatch: true });
  // Classification publication can manually publish an approved, recoverable,
  // CAM-eligible rule that is not yet materialized in CAM setup. Other linked
  // rule blockers mirror the server-side Send-to-CAM gate.
  if (!reason || reason === "not_published_to_cam") return null;

  const decision = deriveRuleDecision(row.rule);
  const paymentTreatment = derivePaymentTreatment(row.rule);
  if (paymentTreatment === "tenant_direct_contract") return "tenant_direct";
  if (paymentTreatment === "included_in_base_rent") return "included_in_base_rent";
  if (decision.recoverability === "not_recoverable") return "not_recoverable";
  if (decision.camEligibility === "not_eligible") return "not_cam_eligible";
  return reason;
}

export function getTenantAllocationBlocker(row) {
  if (!row?.rule || !ruleRequiresPerTenantAllocation(row.rule)) return null;
  const tenant = row?.tenantResolution?.tenant;
  if (tenant?.id || tenant?.name || row?.expense?.tenant_id || row?.expense?.tenant_name || row?.lease?.tenant_id || row?.lease?.tenant_name) {
    return null;
  }
  return row?.tenantResolution?.reason || "tenant_unresolved";
}

export function canSendFinalizedActualToCam(row) {
  const readiness = getCamPublicationReadiness(row);
  return getCamInputDecision(row, { readiness }).state === "ready_to_send";
}

export function isAutomaticCamReadyRow(row) {
  return Boolean(
    canSendFinalizedActualToCam(row) &&
    row?.rule?.published_to_cam === true
  );
}

export function ruleExpectsLandlordActualExpense(rule = {}) {
  const model = deriveNormalizedContractModel(rule);
  const explicitStatus = normalizeText(
    rule?.approval_status ||
    rule?.approved_status ||
    rule?.review_status ||
    rule?.status ||
    rule?.rule_status
  );
  const approvedEnough =
    rule?.published_to_cam === true ||
    model.approval_status === "approved" ||
    ["approved", "finalized", "active", "executed"].includes(explicitStatus);

  return Boolean(
    approvedEnough &&
    model.actual_expense_expected === "yes" &&
    !["tenant_direct", "included_in_rent", "compliance_only"].includes(model.recovery_treatment)
  );
}

// Publication-readiness checklist with exact blocking reasons - the
// client-side mirror of deriveExpenseCamSendBlockers
// (_shared/send-expense-classification-to-cam-workflow.ts) and
// send_expense_classification_to_cam_workflow's own server-side checks
// (20260905000000_cam_publication_rpcs.sql). Server-side remains
// authoritative; this only drives what the UI shows so a reviewer can see
// *why* Send to CAM is disabled without guessing.
export function getClassificationRecoveryBucket(record = {}) {
  const status = normalizeText(record?.classificationStatus || record?.classification_status);
  const recovery = normalizeText(record?.recoverabilityResult || record?.recoverability_result || record?.recovery_status);
  const camEligible = normalizeText(record?.camEligible || record?.cam_eligible);

  if (status === "excluded" || camEligible === "no" || recovery === "excluded") return "excluded";
  if (recovery === "non_recoverable") return "non_recoverable";
  if (recovery === "conditional") return "conditional";
  if (recovery === "recoverable" && camEligible === "yes") return "recoverable";
  return "needs_review";
}

export function getCamPublicationReadiness(row, { publicationStatus = null } = {}) {
  if (publicationStatus === "published") {
    return { ready: true, checks: [], blockers: [], alreadyPublished: true };
  }

  const isRuleGap = row?.rowType === "rule_missing_actual";
  const expenseApproved = isRuleGap || Boolean(row?.actualExpenseId);
  const ruleApproved = !row?.rule || row?.rule?.approval_status === "approved" || row?.rule?.published_to_cam === true;
  const linkedRuleCamBlocker = getLinkedRuleCamBlocker(row);
  const tenantAllocationBlocker = getTenantAllocationBlocker(row);

  const checks = [
    { key: "expense_approved", label: "Expense approved", pass: expenseApproved },
    { key: "rule_approved", label: "Lease rule approved", pass: ruleApproved },
    {
      key: "linked_rule_cam_eligible",
      label: linkedRuleCamBlocker
        ? `Linked lease rule CAM eligible (${humanize(linkedRuleCamBlocker)})`
        : "Linked lease rule CAM eligible",
      pass: !linkedRuleCamBlocker,
    },
    {
      key: "tenant_allocation_resolved",
      label: tenantAllocationBlocker
        ? `Tenant allocation target resolved (${humanize(tenantAllocationBlocker)})`
        : "Tenant allocation target resolved",
      pass: !tenantAllocationBlocker,
    },
    { key: "finalized", label: "Classification finalized", pass: row?.classificationStatus === "finalized" },
    { key: "amount_allocated", label: "Amount fully allocated", pass: Number(row?.amount) > 0 },
    { key: "scope_validated", label: "Scope validated", pass: isRuleGap ? true : Boolean(row?.property) },
    { key: "category_resolved", label: "Canonical expense category resolved", pass: isRuleGap ? true : Boolean(row?.expenseCategoryId) },
    { key: "service_period_set", label: "Service period set", pass: isRuleGap ? true : Boolean(row?.servicePeriodStart && row?.servicePeriodEnd) },
    { key: "conditions_resolved", label: "Conditions resolved", pass: row?.recoverabilityResult !== "conditional" },
    { key: "duplicate_check", label: "Not already published", pass: publicationStatus !== "published" },
    { key: "recoverable", label: "Recoverability is recoverable", pass: row?.recoverabilityResult === "recoverable" },
    { key: "cam_eligible", label: "CAM eligibility is yes", pass: row?.camEligible === "yes" },
  ];

  const blockers = checks.filter((check) => !check.pass).map((check) => check.label);
  return { ready: blockers.length === 0, checks, blockers, alreadyPublished: false };
}

// CAM Input Decision -- the widened status vocabulary a reviewer sees per row,
// replacing the old plain "Recoverability" column. Ten named states plus one
// pre-finalization fallback ("Needs Review") that the spec's list doesn't
// otherwise cover. Purely a display label -- publicationStatus (withdrawn vs
// superseded) and readiness are passed in rather than re-derived, since both
// already exist (cam_expense_inputs lookup, getCamPublicationReadiness).
export function getCamInputDecision(row, { readiness = null, publicationStatus = null } = {}) {
  if (publicationStatus === "superseded") {
    return { state: "superseded", label: "Superseded" };
  }
  if (publicationStatus === "withdrawn") {
    return { state: "withdrawn", label: "Withdrawn" };
  }
  if (publicationStatus === "published") {
    return { state: "published_to_cam", label: "Published to CAM" };
  }

  const classificationBucket = getClassificationRecoveryBucket({ ...(row || {}), ...(row?.classificationRecord || {}) });
  if (classificationBucket === "excluded" || classificationBucket === "non_recoverable") {
    return { state: "not_cam_eligible", label: "Not CAM Eligible" };
  }
  if (classificationBucket === "conditional" && !row?.classificationRecord?.condition_resolved) {
    return { state: "conditional_review_required", label: "Conditional - Review Required" };
  }

  const linkedRuleCamBlocker = getLinkedRuleCamBlocker(row);
  if (linkedRuleCamBlocker) {
    if (linkedRuleCamBlocker === "conditional_unresolved") {
      return { state: "conditional_review_required", label: "Rule Needs CAM Review" };
    }
    return { state: "not_cam_eligible", label: "Rule Not CAM Eligible" };
  }

  const tenantAllocationBlocker = getTenantAllocationBlocker(row);
  if (tenantAllocationBlocker) {
    return { state: "needs_direct_tenant", label: "Needs Tenant / Lease" };
  }

  const isRuleGap = row?.rowType === "rule_missing_actual";
  if (!isRuleGap && row?.actualExpenseId) {
    if (!row?.expenseCategoryId) {
      return { state: "needs_category", label: "Needs Category" };
    }
    if (!row?.servicePeriodStart || !row?.servicePeriodEnd) {
      return { state: "needs_service_period", label: "Needs Service Period" };
    }
    if (!row?.property) {
      return { state: "needs_scope", label: "Needs Scope" };
    }
    const billingTreatment = row?.rule ? leaseExpenseRuleService.getBillingTreatment(row.rule) : null;
    if (billingTreatment === "direct_bill" && !row?.tenantResolution?.tenant) {
      return { state: "needs_direct_tenant", label: "Needs Direct Tenant" };
    }
  }

  const effectiveReadiness = readiness || getCamPublicationReadiness(row, { publicationStatus });
  if (row?.classificationStatus === "finalized" && classificationBucket === "recoverable" && effectiveReadiness.ready) {
    return { state: "ready_to_send", label: "Ready to Send to CAM" };
  }

  return { state: "needs_review", label: "Needs Review" };
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
  const ruleIdsLinkedToActuals = new Set();
  const approvedRuleById = new Map(approvedRules.map((rule) => [rule.id, rule]));
  const rulesByLeaseId = new Map();
  const usedRuleIds = new Set();
  const candidateLeases = scopedLeases.length > 0 ? scopedLeases : leases.filter((lease) => leaseCoversYear(lease, scopeYear));

  for (const classification of existingClassifications) {
    const expenseId = classification.expense_id || classification.actual_expense_id;
    if (expenseId) {
      const existing = classificationByExpenseId.get(expenseId) || null;
      classificationByExpenseId.set(expenseId, preferClassificationRecord(existing, classification));
      const linkedRuleId = classification.lease_expense_rule_id || classification.linked_expense_rule_id || classification.recovery_rule_id;
      if (linkedRuleId) ruleIdsLinkedToActuals.add(linkedRuleId);
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
    const actualExpenseCategoryId = expense.expense_category_id || expense.category_id || expense.canonical_category_id || null;
    const classificationExpenseCategoryId = classificationRecord?.expense_category_id || null;
    const ruleExpenseCategoryId = matchedRule?.expense_category_id || null;
    // Same precedence the server-side canonical-category triggers use
    // (expense_classifications_set_canonical_category(), migration
    // 20269900000048): the classification's own resolved id wins, then the
    // matched rule's canonical category (contractual truth), then whatever
    // the actual expense row itself carries as a last resort.
    const resolvedExpenseCategoryId = classificationExpenseCategoryId || ruleExpenseCategoryId || actualExpenseCategoryId;
    const hasMatchedRule = Boolean(matchedRule);
    if (matchedRule?.id) usedRuleIds.add(matchedRule.id);
    if (persistedRuleId && hasMatchedRule) usedRuleIds.add(persistedRuleId);

    const rawRecoverability = normalizeText(
      classificationRecord?.recoverability_result ||
      classificationRecord?.recovery_status ||
      (matchedRule ? leaseExpenseRuleService.getRecoverableDecision(matchedRule) : null) ||
      expense.recoverability_result ||
      expense.recovery_status ||
      expense.recoverability ||
      match?.recoverability_result
    );

    const recoverabilityResult =
      ["recoverable", "non_recoverable", "conditional", "excluded"].includes(rawRecoverability)
        ? rawRecoverability
        : "recoverable";

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

    const rawCam = normalizeText(
      classificationRecord?.cam_eligible ||
      (matchedRule ? leaseExpenseRuleService.getCamEligibleDecision(matchedRule) : null) ||
      expense.cam_eligible
    );

    const camEligible =
      ["yes", "no", "conditional"].includes(rawCam)
        ? rawCam
        : (recoverabilityResult === "recoverable" ? "yes" : "no");
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
    const classificationBucket = getClassificationRecoveryBucket({
      classificationStatus,
      recoverabilityResult,
      camEligible,
      classificationRecord,
    });
    const leaseTenantName = approvedLeaseFieldValue(lease, ["tenant_name", "tenant", "tenant_legal_name", "lessee"]);
    const expenseForTenantResolution = {
      ...expense,
      lease_id: expense.lease_id || lease?.id || null,
      tenant_id: expense.tenant_id || lease?.tenant_id || null,
      tenant_name: expense.tenant_name || lease?.tenant_name || leaseTenantName || null,
      property_id: expense.property_id || lease?.property_id || null,
      building_id: expense.building_id || lease?.building_id || null,
      unit_id: expense.unit_id || lease?.unit_id || null,
    };
    const tenantResolution = resolveTenantForExpense(expenseForTenantResolution, {
      leases,
      leaseById,
      unitById,
      tenantById,
    });
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
      // Only populated when this expense went through fresh matching this
      // render (see the `if (!matchedRule)` branch above) -- a persisted,
      // already-classified row has no live candidate count to report, so
      // resolveMatchStatus in leaseExpenseRulesHelpers.js treats 0 the same
      // as "not re-evaluated" rather than "no other candidates existed".
      matchCandidateCount: match?.matchCandidateCount || 0,
      expenseDate: expense.expense_date || expense.date || expense.service_period_start || null,
      vendor: expense.vendor || expense.vendor_name || "-",
      tenantLabel: tenantResolution.tenant?.name || "-",
      tenantResolution,
      ruleLabel: matchedRule
        ? `${matchedRule.expense_category || matchedRule.category_name || "-"}${matchedRule.expense_subcategory ? ` / ${matchedRule.expense_subcategory}` : ""}`
        : "-",
      amount: actualAmount,
      financialAmount: actualAmount,
      expenseCategoryId: resolvedExpenseCategoryId,
      actualExpenseCategoryId,
      classificationExpenseCategoryId,
      ruleExpenseCategoryId,
      servicePeriodStart: classificationRecord?.service_period_start || expense.service_period_start || null,
      servicePeriodEnd: classificationRecord?.service_period_end || expense.service_period_end || null,
      recoverabilityResult: classificationBucket,
      rawRecoverabilityResult: recoverabilityResult || "needs_review",
      classificationStatus,
      exceptionType,
      camEligible,
      camStatus,
      recoverableAmount: hasMatchedRule && classificationBucket === "recoverable" ? actualAmount : 0,
      nonRecoverableAmount: hasMatchedRule && classificationBucket === "non_recoverable" ? actualAmount : 0,
      conditionalAmount: hasMatchedRule && classificationBucket === "conditional" ? actualAmount : 0,
      excludedAmount: hasMatchedRule && classificationBucket === "excluded" ? actualAmount : 0,
      sentToCam,
      nextStep:
        (camStatus === "cam_ready" ? "CAM Ready" : classificationRecord?.next_step) ||
        (hasMatchedRule
          ? (
            classificationStatus === "finalized"
              ? (camEligible === "yes" && recoverabilityResult === "recoverable" ? "Send to CAM" : "Ready for projection")
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
        Boolean(row.actualExpenseId) ||
        (row.rowType === "rule_missing_actual" && row.amount != null && Number(row.amount) > 0)
      );
    row.canSendToReview =
      Boolean(row.actualExpenseId) &&
      (row.rowType === "actual_missing_rule" ||
        row.recoverabilityResult === "needs_review" ||
        row.recoverabilityResult === "conditional" ||
        ["unmatched", "exception", "conditional"].includes(row.classificationStatus));
    row.canSendToCam = canSendFinalizedActualToCam(row);

    const decisionObj = getCamDecision(row);
    row.camDecision = decisionObj.label;
    row.camWhy = decisionObj.why;
    result.push(row);
  }

  for (const rule of approvedRules) {
    if (usedRuleIds.has(rule.id) || ruleIdsLinkedToActuals.has(rule.id)) continue;
    if (!ruleExpectsLandlordActualExpense(rule)) continue;
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
      tenantLabel: approvedLeaseFieldValue(lease, ["tenant_name", "tenant", "tenant_legal_name", "lessee"]) || lease?.tenant_name || "-",
      tenantResolution: (approvedLeaseFieldValue(lease, ["tenant_name", "tenant", "tenant_legal_name", "lessee"]) || lease?.tenant_name)
        ? { tenant: { id: lease.tenant_id || null, name: approvedLeaseFieldValue(lease, ["tenant_name", "tenant", "tenant_legal_name", "lessee"]) || lease.tenant_name }, source: "matched_lease", reason: null, lease, unit, reasonText: null }
        : { tenant: null, source: "unresolved", reason: "lease_missing_tenant_id", lease, unit, reasonText: "Matched lease has no tenant_id." },
      ruleLabel: `${rule.expense_category || rule.category_name || "-"}${rule.expense_subcategory ? ` / ${rule.expense_subcategory}` : ""}`,
      amount: null,
      financialAmount: 0,
      expenseCategoryId: c?.expense_category_id || null,
      servicePeriodStart: c?.service_period_start || null,
      servicePeriodEnd: c?.service_period_end || null,
      recoverabilityResult: normalizeText(c?.recoverability_result || c?.recovery_status || leaseExpenseRuleService.getRecoverableDecision(rule)) === "yes"
        ? "recoverable"
        : normalizeText(leaseExpenseRuleService.getRecoverableDecision(rule)) || "needs_review",
      classificationStatus: c?.classification_status || "coverage_gap",
      exceptionType: c?.exception_type || null,
      camEligible: c?.cam_eligible || leaseExpenseRuleService.getCamEligibleDecision(rule) || "no",
      camStatus: normalizeText(c?.cam_status || (isClassificationSentToCam(c) ? "cam_ready" : "needs_review")),
      recoverableAmount: 0,
      nonRecoverableAmount: 0,
      conditionalAmount: 0,
      excludedAmount: 0,
      sentToCam: isClassificationSentToCam(c),
      nextStep: c?.next_step || "Link actual expense or mark no expense",
      message: "Approved lease rule exists, but no actual expense found for this period.",
      canFinalize: false,
      canSendToReview: false,
      canSendToCam: false,
    };

    gapRow.canFinalize = false;
    gapRow.canSendToCam = false;

    const decisionObj = getCamDecision(gapRow);
    gapRow.camDecision = decisionObj.label;
    gapRow.camWhy = decisionObj.why;
    
    result.push(gapRow);
  }

  return result;
}

