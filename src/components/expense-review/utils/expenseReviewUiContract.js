export const EXPENSE_REVIEW_UI_CONTRACT_VERSION = "expense_review_v1";

export const FINAL_DECISIONS = [
  "Pooled CAM",
  "Direct Recovery",
  "Direct Bill",
  "Tenant Direct",
  "Included in Rent",
  "Nonrecoverable",
];

export const EXCEPTION_DECISIONS = [
  "Conditional Review",
  "Needs Category",
  "Needs Scope",
  "Needs Service Period",
  "Needs Tenant / Lease",
  "Policy Conflict",
];

export const CAM_STATUSES = ["Ready to Publish", "Published", "N/A", "Blocked"];

export const POLICY_EVIDENCE = [
  "Recovery Policy",
  "Direct Policy",
  "No Policy Required",
  "Reviewed Override",
];

export const EXCEPTION_BUCKET_LABELS = {
  missing_information: "Missing Information",
  conditional: "Conditional",
  policy_conflict: "Policy Conflict",
  other_review: "Other Review",
};

export const ISSUE_ACTIONS = {
  needs_category: "Assign Category",
  needs_scope: "Complete Scope",
  needs_service_period: "Enter Service Period",
  needs_tenant_lease: "Assign Tenant / Lease",
  conditional_review: "Resolve Condition",
  policy_conflict: "Review Policies",
  other_review: "Review Classification",
};

const FINAL_DECISION_KEYS = new Set([
  "pooled_cam",
  "direct_recovery",
  "direct_bill",
  "tenant_direct",
  "included_in_rent",
  "nonrecoverable",
]);

const EXCEPTION_DECISION_KEYS = new Set([
  "conditional_review",
  "needs_category",
  "needs_scope",
  "needs_service_period",
  "needs_tenant_lease",
  "policy_conflict",
]);

const CAM_DECISION_KEYS = new Set(["pooled_cam", "direct_recovery"]);
const OUTSIDE_CAM_DECISION_KEYS = new Set(["direct_bill", "tenant_direct", "included_in_rent", "nonrecoverable"]);

const DECISION_LABELS = {
  pooled_cam: "Pooled CAM",
  direct_recovery: "Direct Recovery",
  direct_bill: "Direct Bill",
  tenant_direct: "Tenant Direct",
  included_in_rent: "Included in Rent",
  nonrecoverable: "Nonrecoverable",
  conditional_review: "Conditional Review",
  needs_category: "Needs Category",
  needs_scope: "Needs Scope",
  needs_service_period: "Needs Service Period",
  needs_tenant_lease: "Needs Tenant / Lease",
  policy_conflict: "Policy Conflict",
  other_review: "Needs Review",
};

const DECISION_TONES = {
  pooled_cam: "emerald",
  direct_recovery: "blue",
  direct_bill: "indigo",
  tenant_direct: "slate",
  included_in_rent: "slate",
  nonrecoverable: "slate",
  conditional_review: "amber",
  needs_category: "amber",
  needs_scope: "amber",
  needs_service_period: "amber",
  needs_tenant_lease: "amber",
  policy_conflict: "red",
  other_review: "amber",
};

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function squish(value) {
  return normalize(value).replace(/[\s-]+/g, "_");
}

function fieldText(row = {}) {
  return [
    row.financial_route,
    row.classification_decision,
    row.recovery_treatment,
    row.recovery_method,
    row.recovery_status,
    row.recoverability_result,
    row.cam_status,
    row.cam_input_type,
    row.rule_source,
    row.next_step,
    row.recovery_reason,
    row.notes,
  ]
    .filter(Boolean)
    .map((value) => squish(value))
    .join(" ");
}

function isFinalized(row = {}) {
  return normalize(row.classification_status) === "finalized";
}

function hasActivePublishedCamInput(input = null) {
  if (!input) return false;
  const publicationStatus = normalize(input.publication_status || "published");
  const status = normalize(input.status || "active");
  return publicationStatus === "published" && !["withdrawn", "superseded", "inactive", "void"].includes(status);
}

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function isMissingCategory(row = {}) {
  return !hasValue(row.expense_category_id) && !hasValue(row.category);
}

function isMissingScope(row = {}) {
  return !hasValue(row.property_id);
}

function isMissingServicePeriod(row = {}) {
  return !hasValue(row.service_period_start) && !hasValue(row.service_period_end);
}

function needsTenant(row = {}) {
  const text = fieldText(row);
  const explicit = [row.exception_type, row.next_step, row.recovery_reason, row.notes]
    .map((value) => squish(value))
    .join(" ");
  return explicit.includes("needs_tenant") || explicit.includes("tenant_lease") || explicit.includes("tenant_unresolved") || (text.includes("direct_recovery") && !hasValue(row.tenant_id) && !hasValue(row.lease_id));
}

function hasPolicyConflict(row = {}) {
  const text = [row.exception_type, row.next_step, row.recovery_reason, row.notes]
    .map((value) => squish(value))
    .join(" ");
  return text.includes("policy_conflict") || text.includes("multiple_policy") || text.includes("conflicting_policy");
}

function hasConditionalReview(row = {}) {
  const status = squish(row.classification_status);
  const recovery = squish(row.recoverability_result || row.recovery_status);
  const exception = squish(row.exception_type);
  return status === "conditional" || recovery === "conditional" || exception.includes("conditional") || row.condition_resolved === false;
}

export function deriveExpenseReviewDecision(row = {}) {
  if (!isFinalized(row)) {
    const issue = deriveExpenseReviewIssue(row);
    if (EXCEPTION_DECISION_KEYS.has(issue.decision)) {
      return buildDecision(issue.decision);
    }
  }

  const text = fieldText(row);
  const camEligible = squish(row.cam_eligible);

  if (text.includes("direct_bill") || text.includes("route_to_billing")) return buildDecision("direct_bill");
  if (text.includes("tenant_direct") || text.includes("tenant_pays_vendor")) return buildDecision("tenant_direct");
  if (text.includes("included_in_rent") || text.includes("included_in_base_rent") || text.includes("no_separate_recovery")) return buildDecision("included_in_rent");
  if (text.includes("non_recoverable") || text.includes("nonrecoverable") || text.includes("excluded") || text.includes("not_recoverable") || text.includes("accounting_only")) return buildDecision("nonrecoverable");
  if (text.includes("direct_recovery") || text.includes("direct_recover") || text.includes("direct_tenant")) return buildDecision("direct_recovery");
  if (text.includes("pooled_cam") || text.includes("pooled_recovery") || text.includes("cam_pool")) return buildDecision("pooled_cam");
  if (camEligible === "no" || camEligible === "false") return buildDecision("nonrecoverable");
  if (camEligible === "yes" || text.includes("recoverable")) return buildDecision("pooled_cam");

  return buildDecision("nonrecoverable");
}

function buildDecision(value) {
  return {
    value,
    label: DECISION_LABELS[value] || "Needs Review",
    tone: DECISION_TONES[value] || "slate",
    isFinalDecision: FINAL_DECISION_KEYS.has(value),
    isExceptionDecision: EXCEPTION_DECISION_KEYS.has(value),
    isCamRoute: CAM_DECISION_KEYS.has(value),
    isOutsideCam: OUTSIDE_CAM_DECISION_KEYS.has(value),
  };
}

export function deriveExpenseReviewIssue(row = {}) {
  const status = squish(row.classification_status);
  const recoverability = squish(row.recoverability_result || row.recovery_status);
  const exception = squish(row.exception_type);

  if (hasPolicyConflict(row)) return buildIssue("policy_conflict", "Policy Conflict", "policy_conflict");
  if (exception.includes("category") || status.includes("needs_category") || isMissingCategory(row)) {
    return buildIssue("needs_category", "Missing category", "missing_information");
  }
  if (exception.includes("scope") || status.includes("needs_scope") || isMissingScope(row)) {
    return buildIssue("needs_scope", "Missing property or scope", "missing_information");
  }
  if (exception.includes("service_period") || status.includes("needs_service_period") || isMissingServicePeriod(row)) {
    return buildIssue("needs_service_period", "Missing service period", "missing_information");
  }
  if (needsTenant(row)) return buildIssue("needs_tenant_lease", "Tenant / lease required", "missing_information");
  if (hasConditionalReview(row)) return buildIssue("conditional_review", "Condition requires review", "conditional");
  if (["unmatched", "exception", "needs_review"].includes(status) || recoverability === "needs_review" || (exception && !["none", "null"].includes(exception))) {
    return buildIssue("other_review", "Review required", "other_review");
  }
  return buildIssue("resolved", "Resolved", "resolved");
}

function buildIssue(decision, label, bucket) {
  return {
    decision,
    label,
    bucket,
    bucketLabel: EXCEPTION_BUCKET_LABELS[bucket] || "Other Review",
    requiredDecision: ISSUE_ACTIONS[decision] || "Review Classification",
    tone: DECISION_TONES[decision] || "amber",
  };
}

export function isExpenseReviewException(row = {}) {
  if (!row || row.row_type === "rule_missing_actual") return false;
  if (isFinalized(row)) return false;
  const issue = deriveExpenseReviewIssue(row);
  return issue.decision !== "resolved";
}

export function isExpenseReviewFinalized(row = {}) {
  if (!row || row.row_type === "rule_missing_actual") return false;
  return isFinalized(row) && deriveExpenseReviewDecision(row).isFinalDecision;
}

export function deriveExpenseReviewPolicyEvidence(row = {}, decision = deriveExpenseReviewDecision(row)) {
  const source = squish(row.rule_source);
  const hasRule = hasValue(row.lease_expense_rule_id) || hasValue(row.recovery_rule_id);
  if (row.manual_cam_reviewed || source.includes("override")) return evidence("Reviewed Override", "amber");
  if (decision.value === "direct_recovery" || decision.value === "direct_bill") return evidence("Direct Policy", "blue");
  if (["tenant_direct", "included_in_rent", "nonrecoverable"].includes(decision.value)) return evidence("No Policy Required", "slate");
  if (decision.value === "pooled_cam" || hasRule) return evidence("Recovery Policy", "emerald");
  return evidence("No Policy Required", "slate");
}

function evidence(label, tone) {
  return { label, tone };
}

export function deriveExpenseReviewCamStatus(row = {}, publishedInput = null, decision = deriveExpenseReviewDecision(row)) {
  if (hasActivePublishedCamInput(publishedInput) || row.sent_to_cam === true || normalize(row.cam_status) === "published") {
    return { label: "Published", tone: "blue", reason: "Active published CAM input exists." };
  }

  if (decision.isOutsideCam) {
    return { label: "N/A", tone: "slate", reason: "Valid outside-CAM financial route." };
  }

  if (decision.isCamRoute) {
    const blocker = getCamBlocker(row);
    if (blocker) return { label: "Blocked", tone: "red", reason: blocker };
    return { label: "Ready to Publish", tone: "emerald", reason: "Finalized CAM-eligible route not yet published." };
  }

  return { label: "Blocked", tone: "red", reason: "Classification decision is not finalized." };
}

function getCamBlocker(row = {}) {
  const camEligible = squish(row.cam_eligible);
  if (["no", "false", "not_eligible"].includes(camEligible)) return "Classification is marked not CAM eligible.";
  if (["needs_review", "pending", "conditional"].includes(camEligible)) return "CAM eligibility is unresolved.";
  if (isMissingCategory(row)) return "Category is missing.";
  if (isMissingScope(row)) return "Property or scope is missing.";
  if (needsTenant(row)) return "Tenant or lease is required for this recovery route.";
  return null;
}

export function canSendExpenseReviewRowToCam(row = {}, publishedInput = null) {
  const decision = deriveExpenseReviewDecision(row);
  const camStatus = deriveExpenseReviewCamStatus(row, publishedInput, decision);
  return isExpenseReviewFinalized(row) && decision.isCamRoute && camStatus.label === "Ready to Publish";
}

export function buildExpenseReviewUiRow(row = {}, { publishedInput = null } = {}) {
  const decision = deriveExpenseReviewDecision(row);
  const issue = deriveExpenseReviewIssue(row);
  const camStatus = deriveExpenseReviewCamStatus(row, publishedInput, decision);
  return {
    ...row,
    v1Decision: decision,
    v1Issue: issue,
    v1PolicyEvidence: deriveExpenseReviewPolicyEvidence(row, decision),
    v1CamStatus: camStatus,
    v1CanSendToCam: canSendExpenseReviewRowToCam(row, publishedInput),
  };
}

export function getExpenseReviewExceptionCounts(rows = []) {
  return rows.reduce((counts, row) => {
    const bucket = row.v1Issue?.bucket || deriveExpenseReviewIssue(row).bucket;
    if (bucket === "missing_information") counts.missingInformation += 1;
    else if (bucket === "conditional") counts.conditional += 1;
    else if (bucket === "policy_conflict") counts.policyConflict += 1;
    else if (bucket !== "resolved") counts.otherReview += 1;
    counts.total += 1;
    counts.amount += Number(row.amount || 0) || 0;
    return counts;
  }, {
    missingInformation: 0,
    conditional: 0,
    policyConflict: 0,
    otherReview: 0,
    total: 0,
    amount: 0,
  });
}

export function calculateExpenseReviewTieOut(finalizedRows = [], publishedInputsByClassificationId = new Map()) {
  const totals = {
    totalFinalized: 0,
    rows: 0,
    readyForCam: 0,
    readyForCamRows: 0,
    publishedCam: 0,
    publishedCamRows: 0,
    outsideCam: 0,
    outsideCamRows: 0,
    pooledCam: 0,
    directRecovery: 0,
    directBill: 0,
    tenantDirect: 0,
    includedInRent: 0,
    nonrecoverable: 0,
    routeTotal: 0,
    tieOutDelta: 0,
    tieOutOk: true,
  };

  for (const row of finalizedRows) {
    const amount = Number(row.amount || 0) || 0;
    const decision = row.v1Decision || deriveExpenseReviewDecision(row);
    const input = publishedInputsByClassificationId.get(row.id);
    const camStatus = row.v1CamStatus || deriveExpenseReviewCamStatus(row, input, decision);
    totals.totalFinalized += amount;
    totals.rows += 1;
    switch (decision.value) {
      case "pooled_cam":
        totals.pooledCam += amount;
        break;
      case "direct_recovery":
        totals.directRecovery += amount;
        break;
      case "direct_bill":
        totals.directBill += amount;
        totals.outsideCam += amount;
        totals.outsideCamRows += 1;
        break;
      case "tenant_direct":
        totals.tenantDirect += amount;
        totals.outsideCam += amount;
        totals.outsideCamRows += 1;
        break;
      case "included_in_rent":
        totals.includedInRent += amount;
        totals.outsideCam += amount;
        totals.outsideCamRows += 1;
        break;
      case "nonrecoverable":
        totals.nonrecoverable += amount;
        totals.outsideCam += amount;
        totals.outsideCamRows += 1;
        break;
      default:
        break;
    }
    if (camStatus.label === "Ready to Publish") {
      totals.readyForCam += amount;
      totals.readyForCamRows += 1;
    }
    if (camStatus.label === "Published") {
      totals.publishedCam += camInputAmount(input) || amount;
      totals.publishedCamRows += 1;
    }
  }

  totals.routeTotal = totals.pooledCam + totals.directRecovery + totals.directBill + totals.tenantDirect + totals.includedInRent + totals.nonrecoverable;
  totals.tieOutDelta = Number((totals.totalFinalized - totals.routeTotal).toFixed(2));
  totals.tieOutOk = Math.abs(totals.tieOutDelta) < 0.01;
  return totals;
}

export function camInputAmount(input = {}) {
  return Number(input?.eligible_amount ?? input?.actual_amount ?? input?.amount ?? 0) || 0;
}

export function filterFinalizedExpenseReviewRows(rows = [], filter = "all") {
  if (filter === "ready_for_cam") return rows.filter((row) => row.v1CamStatus?.label === "Ready to Publish");
  if (filter === "published") return rows.filter((row) => row.v1CamStatus?.label === "Published");
  if (filter === "outside_cam") return rows.filter((row) => row.v1Decision?.isOutsideCam);
  if (FINAL_DECISION_KEYS.has(filter)) return rows.filter((row) => row.v1Decision?.value === filter);
  return rows;
}

export function buildExpenseReviewReportRows(rows = []) {
  return rows.map((row) => ({
    Expense: row.description || row.category || "Expense",
    Date: row.service_period_start || row.service_period_end || row.expense_date || row.classified_at || "",
    Vendor: row.vendor_name || row.vendor || "",
    Property: row.property_name || "",
    Building: row.building_name || "",
    Unit: row.unit_name || row.unit_number || row.unit_id_code || "",
    Tenant: row.tenant_name || "",
    Category: row.category || "",
    Amount: Number(row.amount || 0) || 0,
    Decision: row.v1Decision?.label || deriveExpenseReviewDecision(row).label,
    "CAM Status": row.v1CamStatus?.label || deriveExpenseReviewCamStatus(row).label,
    "Policy Evidence": row.v1PolicyEvidence?.label || deriveExpenseReviewPolicyEvidence(row).label,
    Finalized: row.finalized_at || row.reviewed_at || "",
    Source: row.rule_source || row.evidence_text || "",
  }));
}
