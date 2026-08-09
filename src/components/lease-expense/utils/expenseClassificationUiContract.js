import { deriveNormalizedContractModel } from "@/services/utils/ruleDecisionEngine";

export const EXPENSE_CLASSIFICATION_UI_CONTRACT_VERSION = "expense_classification_v1";

export const CLASSIFICATION_TABS = [
  { value: "all", label: "All" },
  { value: "ready_for_cam", label: "Ready for CAM" },
  { value: "needs_review", label: "Needs Review" },
  { value: "outside_cam", label: "Outside CAM" },
  { value: "published", label: "Published" },
  { value: "coverage_gaps", label: "Coverage Gaps" },
];

export const POLICY_EVIDENCE_LABELS = {
  policy_coverage_found: "Policy Coverage Found",
  direct_policy_found: "Direct Policy Found",
  multiple_policy_matches: "Multiple Policy Matches",
  no_policy_coverage: "No Policy Coverage",
  no_policy_required: "No Policy Required",
  needs_review: "Needs Review",
};

export const DECISION_LABELS = {
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
  published: "Published",
};

export const NEXT_STEP_BY_DECISION = {
  pooled_cam: "Ready to Send to CAM",
  direct_recovery: "Ready to Send to CAM",
  direct_bill: "Route to Billing",
  tenant_direct: "No CAM \u2014 Tenant Pays Vendor",
  included_in_rent: "No Separate Recovery",
  nonrecoverable: "Accounting Only",
  conditional_review: "Resolve Condition",
  needs_category: "Assign Category",
  needs_scope: "Complete Scope",
  needs_service_period: "Enter Service Period",
  needs_tenant_lease: "Assign Tenant / Lease",
  policy_conflict: "Review Policies",
  published: "Published to CAM",
};

const DECISION_TONE = {
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
  published: "blue",
};

const REVIEW_DECISIONS = new Set([
  "conditional_review",
  "needs_category",
  "needs_scope",
  "needs_service_period",
  "needs_tenant_lease",
  "policy_conflict",
]);

const OUTSIDE_CAM_DECISIONS = new Set(["direct_bill", "tenant_direct", "included_in_rent", "nonrecoverable"]);
const CAM_ROUTE_DECISIONS = new Set(["pooled_cam", "direct_recovery"]);

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeTreatment(row = {}) {
  const model = row?.rule ? deriveNormalizedContractModel(row.rule) : {};
  return normalize(
    row?.classificationRecord?.recovery_treatment ||
    row?.rule?.recovery_treatment ||
    model.recovery_treatment ||
    row?.rule?.normalizedContractModel?.recovery_treatment ||
    row?.rule?.recovery_method ||
    row?.rule?.billing_treatment
  );
}

function isDirectRecoveryTreatment(row = {}, treatment = normalizeTreatment(row)) {
  return treatment === "direct_recovery" || row?.rule?.direct_tenant_charge === true;
}

function isPolicyConflict(row = {}) {
  return normalize(row?.classificationRecord?.exception_type || row?.exceptionType) === "policy_conflict" || Number(row?.matchCandidateCount || 0) > 1;
}

export function deriveClassificationDecision(row = {}, camInputDecision = {}) {
  const decisionState = camInputDecision?.state || "";
  const treatment = normalizeTreatment(row);
  const recovery = normalize(row?.recoverabilityResult || row?.rawRecoverabilityResult || row?.classificationRecord?.recoverability_result);
  const classificationStatus = normalize(row?.classificationStatus || row?.classificationRecord?.classification_status);

  if (decisionState === "published_to_cam") return decision("published", row, treatment);
  if (isPolicyConflict(row)) return decision("policy_conflict", row, treatment);
  if (decisionState === "needs_category" || (!row?.expenseCategoryId && row?.actualExpenseId)) return decision("needs_category", row, treatment);
  if (decisionState === "needs_scope" || (!row?.property && row?.actualExpenseId)) return decision("needs_scope", row, treatment);
  if (decisionState === "needs_service_period" || ((!row?.servicePeriodStart || !row?.servicePeriodEnd) && row?.actualExpenseId)) return decision("needs_service_period", row, treatment);
  if (decisionState === "needs_direct_tenant") return decision("needs_tenant_lease", row, treatment);
  if (decisionState === "conditional_review_required" || recovery === "conditional" || classificationStatus === "conditional") return decision("conditional_review", row, treatment);

  if (treatment === "direct_bill") return decision("direct_bill", row, treatment);
  if (treatment === "tenant_direct") return decision("tenant_direct", row, treatment);
  if (treatment === "included_in_rent") return decision("included_in_rent", row, treatment);
  if (treatment === "nonrecoverable" || treatment === "compliance_only") return decision("nonrecoverable", row, treatment);

  if (["non_recoverable", "nonrecoverable", "excluded"].includes(recovery) || decisionState === "not_cam_eligible") {
    return decision("nonrecoverable", row, treatment);
  }

  if (row?.rowType === "actual_missing_rule" || classificationStatus === "unmatched") return decision("policy_conflict", row, treatment);
  if (isDirectRecoveryTreatment(row, treatment)) return decision("direct_recovery", row, treatment);
  return decision("pooled_cam", row, treatment);
}

function decision(value, row, treatment) {
  const financialBucket = value === "published"
    ? (isDirectRecoveryTreatment(row, treatment) ? "direct_recovery" : "pooled_cam")
    : value;
  return {
    value,
    label: DECISION_LABELS[value],
    tone: DECISION_TONE[value] || "slate",
    nextStep: NEXT_STEP_BY_DECISION[value],
    financialBucket,
  };
}

export function derivePolicyEvidence(row = {}, decisionInfo = deriveClassificationDecision(row)) {
  if (isPolicyConflict(row)) return evidence("multiple_policy_matches", "amber");
  if (row?.rowType === "actual_missing_rule") return evidence("no_policy_coverage", "red");
  if (REVIEW_DECISIONS.has(decisionInfo.value)) return evidence("needs_review", "amber");
  if (["tenant_direct", "included_in_rent", "nonrecoverable"].includes(decisionInfo.financialBucket)) return evidence("no_policy_required", "slate");
  if (["direct_recovery", "direct_bill"].includes(decisionInfo.financialBucket)) return evidence("direct_policy_found", "blue");
  return evidence("policy_coverage_found", "emerald");
}

function evidence(value, tone) {
  return { value, label: POLICY_EVIDENCE_LABELS[value], tone };
}

export function deriveClassificationWorkflowStatus(row = {}, decisionInfo = deriveClassificationDecision(row)) {
  if (decisionInfo.value === "published") return { label: "Published", tone: "blue" };
  if (REVIEW_DECISIONS.has(decisionInfo.value)) return { label: "Needs Review", tone: decisionInfo.value === "policy_conflict" ? "red" : "amber" };
  if (normalize(row?.classificationStatus) === "finalized") return { label: "Finalized", tone: "emerald" };
  return { label: "Pending Finalization", tone: "slate" };
}

export function getClassificationTabValue(row = {}, decisionInfo = deriveClassificationDecision(row), statusInfo = deriveClassificationWorkflowStatus(row, decisionInfo)) {
  if (row?.rowType === "rule_missing_actual") return "coverage_gaps";
  if (decisionInfo.value === "published") return "published";
  if (OUTSIDE_CAM_DECISIONS.has(decisionInfo.financialBucket)) return "outside_cam";
  if (REVIEW_DECISIONS.has(decisionInfo.value)) return "needs_review";
  if (CAM_ROUTE_DECISIONS.has(decisionInfo.financialBucket)) return "ready_for_cam";
  return "all";
}

export function buildClassificationUiRow(row = {}, camInputDecision = {}, readiness = {}) {
  const decisionInfo = deriveClassificationDecision(row, camInputDecision);
  const statusInfo = deriveClassificationWorkflowStatus(row, decisionInfo);
  return {
    ...row,
    v1Decision: decisionInfo,
    v1PolicyEvidence: derivePolicyEvidence(row, decisionInfo),
    v1Status: statusInfo,
    v1NextStep: decisionInfo.nextStep,
    v1Tab: getClassificationTabValue(row, decisionInfo, statusInfo),
    v1Readiness: readiness,
  };
}

export function isReadyForCamV1(uiRow = {}) {
  return uiRow?.v1Tab === "ready_for_cam";
}

export function isNeedsReviewV1(uiRow = {}) {
  return uiRow?.v1Tab === "needs_review";
}

export function isOutsideCamV1(uiRow = {}) {
  return uiRow?.v1Tab === "outside_cam";
}

export function calculateClassificationTieOut(uiRows = [], publishedInputs = []) {
  const totals = {
    approvedActualExpenses: 0,
    pooledCam: 0,
    directRecovery: 0,
    directBill: 0,
    tenantDirect: 0,
    includedInRent: 0,
    nonrecoverable: 0,
    conditionalNeedsReview: 0,
    routeTotal: 0,
    tieOutDelta: 0,
    tieOutOk: true,
    publishedPooledInputs: 0,
    publishedDirectRecoveryInputs: 0,
    publishedCamTotal: 0,
  };

  for (const row of uiRows) {
    if (!row?.actualExpenseId) continue;
    const amount = Number(row.financialAmount ?? row.amount) || 0;
    totals.approvedActualExpenses += amount;
    switch (row.v1Decision?.financialBucket) {
      case "pooled_cam":
        totals.pooledCam += amount;
        break;
      case "direct_recovery":
        totals.directRecovery += amount;
        break;
      case "direct_bill":
        totals.directBill += amount;
        break;
      case "tenant_direct":
        totals.tenantDirect += amount;
        break;
      case "included_in_rent":
        totals.includedInRent += amount;
        break;
      case "nonrecoverable":
        totals.nonrecoverable += amount;
        break;
      default:
        totals.conditionalNeedsReview += amount;
        break;
    }
  }

  totals.routeTotal = totals.pooledCam + totals.directRecovery + totals.directBill + totals.tenantDirect + totals.includedInRent + totals.nonrecoverable + totals.conditionalNeedsReview;
  totals.tieOutDelta = Number((totals.approvedActualExpenses - totals.routeTotal).toFixed(2));
  totals.tieOutOk = Math.abs(totals.tieOutDelta) < 0.01;

  for (const input of publishedInputs || []) {
    if (!isActivePublishedCamInput(input)) continue;
    const amount = Number(input.amount) || 0;
    if (isDirectRecoveryPublishedInput(input)) totals.publishedDirectRecoveryInputs += amount;
    else totals.publishedPooledInputs += amount;
  }
  totals.publishedCamTotal = totals.publishedPooledInputs - totals.publishedDirectRecoveryInputs;

  return totals;
}

export function isActivePublishedCamInput(input = {}) {
  const publicationStatus = normalize(input.publication_status);
  const status = normalize(input.status || "active");
  return publicationStatus === "published" && !["withdrawn", "superseded", "inactive", "void"].includes(status);
}

export function isDirectRecoveryPublishedInput(input = {}) {
  const method = normalize(input.recovery_method || input.cam_input_type || input.input_type || input.allocation_basis);
  return method.includes("direct_recovery") || method === "direct" || method === "direct_tenant";
}

export function buildClassificationCounts(uiRows = []) {
  return {
    all: uiRows.filter((row) => row.rowType !== "rule_missing_actual").length,
    ready_for_cam: uiRows.filter((row) => row.v1Tab === "ready_for_cam").length,
    needs_review: uiRows.filter((row) => row.v1Tab === "needs_review").length,
    outside_cam: uiRows.filter((row) => row.v1Tab === "outside_cam").length,
    published: uiRows.filter((row) => row.v1Tab === "published").length,
    coverage_gaps: uiRows.filter((row) => row.v1Tab === "coverage_gaps").length,
  };
}