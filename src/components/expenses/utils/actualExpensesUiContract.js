export const ACTUAL_EXPENSES_UI_CONTRACT_VERSION = "actual_expenses_v1";

export const ACCOUNTING_STATUS_LABELS = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
};

export const RECOVERY_STATUS_LABELS = {
  pending_classification: "Pending Classification",
  pooled_cam: "Pooled CAM",
  direct_recovery: "Direct Recovery",
  direct_bill: "Direct Bill",
  tenant_direct: "Tenant Direct",
  included_in_rent: "Included in Rent",
  nonrecoverable: "Nonrecoverable",
  conditional_review: "Conditional Review",
  needs_review: "Needs Review",
  published_to_cam: "Published to CAM",
};

export const PRIMARY_FILTERS = [
  { value: "all", label: "All" },
  { value: "pending_approval", label: "Pending Approval" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "needs_classification", label: "Needs Classification" },
];

export const RECOVERY_FILTERS = [
  { value: "all", label: "All Recovery" },
  { value: "pooled_cam", label: "Pooled CAM" },
  { value: "direct_recovery", label: "Direct Recovery" },
  { value: "direct_bill", label: "Direct Bill" },
  { value: "tenant_direct", label: "Tenant Direct" },
  { value: "included_in_rent", label: "Included in Rent" },
  { value: "nonrecoverable", label: "Nonrecoverable" },
  { value: "conditional_review", label: "Conditional Review" },
  { value: "published_to_cam", label: "Published" },
];

function normalizeToken(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function classificationTimestamp(classification = {}) {
  const value = Date.parse(classification.finalized_at || classification.reviewed_at || classification.classified_at || classification.updated_at || "");
  return Number.isFinite(value) ? value : 0;
}

function classificationPriority(classification = {}) {
  const status = normalizeToken(classification.classification_status);
  const approved = normalizeToken(classification.approved_status);
  const sent = classification.sent_to_cam === true || normalizeToken(classification.cam_status) === "published" ? 20 : 0;
  const finalized = status === "finalized" ? 100 : 0;
  const approvedScore = approved === "approved" ? 10 : 0;
  const exceptionPenalty = ["exception", "unmatched", "conditional"].includes(status) ? -20 : 0;
  return finalized + approvedScore + sent + exceptionPenalty;
}

export function selectCanonicalExpenseClassification(classifications = []) {
  const rows = (Array.isArray(classifications) ? classifications : [classifications]).filter(Boolean);
  if (rows.length <= 1) return rows[0] || null;
  return [...rows].sort((left, right) => {
    const priorityDelta = classificationPriority(right) - classificationPriority(left);
    if (priorityDelta !== 0) return priorityDelta;
    return classificationTimestamp(right) - classificationTimestamp(left);
  })[0] || null;
}

function routeText(classification = {}) {
  return [
    classification.financial_route,
    classification.classification_decision,
    classification.recovery_treatment,
    classification.recovery_method,
    classification.payment_treatment,
    classification.recovery_status,
    classification.recoverability_result,
    classification.next_step,
    classification.recovery_reason,
    classification.notes,
  ]
    .filter(Boolean)
    .map((value) => normalizeToken(value))
    .join(" ");
}
export function getAccountingStatus(expense = {}) {
  const status = normalizeToken(expense.approval_status || expense.approved_status || expense.review_status);
  if (status === "approved") return { value: "approved", label: ACCOUNTING_STATUS_LABELS.approved, tone: "emerald" };
  if (status === "rejected") return { value: "rejected", label: ACCOUNTING_STATUS_LABELS.rejected, tone: "red" };
  return { value: "pending", label: ACCOUNTING_STATUS_LABELS.pending, tone: "amber" };
}

export function hasCanonicalCategory(expense = {}) {
  return Boolean(expense.expense_category_id);
}

export function getCanonicalCategoryLabel(expense = {}, categoryById = new Map()) {
  const categoryId = expense.expense_category_id || null;
  if (!categoryId) {
    return { value: "needs_category", label: "Needs Category", subcategory: null, tone: "amber" };
  }
  const category = categoryById.get(categoryId) || null;
  return {
    value: categoryId,
    label: category?.category_name || category?.name || `Category ${String(categoryId).slice(0, 8)}`,
    subcategory: category?.subcategory_name || category?.subcategory || null,
    tone: "slate",
  };
}

export function getRecoveryStatusFromClassification(classification = null) {
  if (!classification) {
    return { value: "pending_classification", label: RECOVERY_STATUS_LABELS.pending_classification, tone: "amber" };
  }

  const publicationStatus = normalizeToken(classification.publication_status || classification.status);
  const camStatus = normalizeToken(classification.cam_status);
  if (
    classification.sent_to_cam === true ||
    publicationStatus === "published" ||
    publicationStatus === "cam_ready" ||
    camStatus === "published" ||
    camStatus === "sent_to_cam"
  ) {
    return { value: "published_to_cam", label: RECOVERY_STATUS_LABELS.published_to_cam, tone: "emerald" };
  }

  const text = routeText(classification);
  const method = normalizeToken(classification.recovery_method || classification.recovery_treatment || classification.payment_treatment);
  if (text.includes("route_to_billing")) {
    return { value: "direct_bill", label: RECOVERY_STATUS_LABELS.direct_bill, tone: "blue" };
  }
  if (text.includes("tenant_pays_vendor") || text.includes("tenant_direct")) {
    return { value: "tenant_direct", label: RECOVERY_STATUS_LABELS.tenant_direct, tone: "slate" };
  }
  if (text.includes("no_separate_recovery") || text.includes("included_in_rent") || text.includes("included_in_base_rent")) {
    return { value: "included_in_rent", label: RECOVERY_STATUS_LABELS.included_in_rent, tone: "slate" };
  }
  if (text.includes("accounting_only") || text.includes("nonrecoverable") || text.includes("non_recoverable") || text.includes("not_recoverable")) {
    return { value: "nonrecoverable", label: RECOVERY_STATUS_LABELS.nonrecoverable, tone: "red" };
  }

  if (["direct_recovery", "actual_usage", "tenant_reimbursement"].includes(method)) {
    return { value: "direct_recovery", label: RECOVERY_STATUS_LABELS.direct_recovery, tone: "blue" };
  }
  if (["direct_bill", "fee", "fee_charge", "separately_billed"].includes(method)) {
    return { value: "direct_bill", label: RECOVERY_STATUS_LABELS.direct_bill, tone: "blue" };
  }
  if (["tenant_direct", "tenant_direct_contract"].includes(method)) {
    return { value: "tenant_direct", label: RECOVERY_STATUS_LABELS.tenant_direct, tone: "slate" };
  }
  if (["included_in_rent", "included_in_base_rent"].includes(method)) {
    return { value: "included_in_rent", label: RECOVERY_STATUS_LABELS.included_in_rent, tone: "slate" };
  }

  const result = normalizeToken(classification.recoverability_result || classification.recovery_status || classification.classification);
  if (["pooled_cam", "pooled_recovery", "cam", "cam_eligible"].includes(result)) {
    return { value: "pooled_cam", label: RECOVERY_STATUS_LABELS.pooled_cam, tone: "emerald" };
  }
  if (result === "recoverable" && ["yes", "true", "eligible"].includes(normalizeToken(classification.cam_eligible))) {
    return { value: "pooled_cam", label: RECOVERY_STATUS_LABELS.pooled_cam, tone: "emerald" };
  }
  if (["direct_recovery", "actual_usage", "tenant_reimbursement"].includes(result)) {
    return { value: "direct_recovery", label: RECOVERY_STATUS_LABELS.direct_recovery, tone: "blue" };
  }
  if (["direct_bill", "fee", "fee_charge"].includes(result)) {
    return { value: "direct_bill", label: RECOVERY_STATUS_LABELS.direct_bill, tone: "blue" };
  }
  if (["tenant_direct", "tenant_direct_contract"].includes(result)) {
    return { value: "tenant_direct", label: RECOVERY_STATUS_LABELS.tenant_direct, tone: "slate" };
  }
  if (["included_in_rent", "included_in_base_rent"].includes(result)) {
    return { value: "included_in_rent", label: RECOVERY_STATUS_LABELS.included_in_rent, tone: "slate" };
  }
  if (["nonrecoverable", "non_recoverable", "excluded", "not_recoverable"].includes(result)) {
    return { value: "nonrecoverable", label: RECOVERY_STATUS_LABELS.nonrecoverable, tone: "red" };
  }
  if (["conditional", "conditional_review", "manual_review"].includes(result)) {
    return { value: "conditional_review", label: RECOVERY_STATUS_LABELS.conditional_review, tone: "amber" };
  }
  if (["needs_review", "exception", "unmatched"].includes(result) || normalizeToken(classification.classification_status) === "exception") {
    return { value: "needs_review", label: RECOVERY_STATUS_LABELS.needs_review, tone: "amber" };
  }

  return { value: "pending_classification", label: RECOVERY_STATUS_LABELS.pending_classification, tone: "amber" };
}

export function expenseNeedsClassification(expense = {}, classification = null) {
  if (!hasCanonicalCategory(expense)) return true;
  const recovery = getRecoveryStatusFromClassification(classification).value;
  return recovery === "pending_classification" || recovery === "needs_review";
}