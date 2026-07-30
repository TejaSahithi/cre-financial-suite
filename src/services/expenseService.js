import {
  toNumber,
  asNumberOrNull,
  normalizeText,
  cleanUuid,
  normalizeDateCandidate,
  normalizeLeaseStatus,
  normalizeRuleStatus,
  normalizeSourceType,
  leaseOverlapsFiscalYear,
  deriveLeaseExpenseFiscalYear,
  deriveLeaseExpenseDate,
  expenseServiceDate,
  compactDefined,
  buildLeaseLookup,
  isMissingExpenseRuleTable,
  extractMissingColumn,
  isMissingColumnError
} from "./utils/expenseParsers";
import {
  bumpExclusion,
  EMPTY_ACTUAL_EXCLUSIONS,
  EMPTY_RULE_EXCLUSIONS,
} from "./utils/expenseClassificationExclusions";
import {
  canSendClassificationToCam,
  hasExplicitCamExclusion,
  isClassificationSentToCam,
} from "./utils/expenseCamEligibility";
import {
  CamEligibilityError,
  ClassificationEligibilityError,
} from "./utils/expenseWorkflowErrors";

import { clearCache, createEntityService, getCurrentOrgId } from "@/services/api";
import { supabase } from "@/services/supabaseClient";
import { invokeEdgeFunction } from "@/services/edgeFunctions";
import { leaseExpenseRuleService } from "@/services/leaseExpenseRuleService";
import {
  createRuleReviewIdempotencyKey,
  publishLeaseExpenseRuleToCam,
} from "@/services/leaseExpenseRuleWorkflowService";
import {
  createExpenseClassificationCamSendIdempotencyKey,
  sendExpenseClassificationToCam,
  reviewExpenseClassification,
} from "@/services/expenseClassificationWorkflowService";
import { getStoredActingOrgId } from "@/lib/actingOrg";
import { resolveTableName } from "@/types";
import {
  getActualClassificationExclusionReason,
  getRuleCamExclusionReason,
  getRuleClassificationExclusionReason,
  isActualClassificationEligible,
  isRuleCamEligible,
  isRuleClassificationEligible,
} from "@/lib/expenseEligibility";

import {
  getEffectiveApprovalStatus,
  getRawReviewStatus,
} from "@/lib/ruleStatus";
import {
  resolveTenantForExpense,
  ruleRequiresPerTenantAllocation,
} from "@/lib/tenantResolver";

const baseExpenseService = createEntityService("Expense");
const baseLeaseService = createEntityService("Lease");

const CONDITIONAL_KEYWORDS = ["subject to", "provided that", "unless", "if ", "condition", "gross-up", "base year", "cap"];






function normalizeRecoveryStatus(rule) {
  return leaseExpenseRuleService.normalizeRecoveryStatus(rule);
}








function buildApprovedRuleLookups(ruleRows = [], categories = []) {
  const categoriesById = new Map((categories || []).map((category) => [category.id, category]));
  const rulesByLeaseId = new Map();

  for (const rule of ruleRows || []) {
    if (!approvedRuleForMatching(rule)) continue;
    const existing = rulesByLeaseId.get(rule.lease_id) || [];
    existing.push({
      ...rule,
      category: categoriesById.get(rule.expense_category_id) || null,
    });
    rulesByLeaseId.set(rule.lease_id, existing);
  }

  return { categoriesById, rulesByLeaseId };
}

function extractRuleChargeAmount(rule) {
  return asNumberOrNull(rule?.final_value ?? rule?.manual_value ?? rule?.extracted_value);
}

function buildRuleDerivedPayloads(lease, rules = [], propertyById) {
  const property = propertyById.get(lease?.property_id) || null;
  const fiscalYear = deriveLeaseExpenseFiscalYear(lease);
  const expenseDate = deriveLeaseExpenseDate(lease, fiscalYear);
  const month = Number(expenseDate.slice(5, 7)) || 1;
  const tenantName = String(lease?.tenant_name || "Lease");

  return rules.flatMap((rule) => {
    const amount = extractRuleChargeAmount(rule);
    if (!amount || amount <= 0) return [];
    if (normalizeRuleStatus(rule) !== "mapped") return [];

    const recoveryStatus = normalizeRecoveryStatus(rule);
    if (!["recoverable", "conditional"].includes(recoveryStatus)) return [];

    const categoryName = rule?.category?.normalized_key || rule?.category?.subcategory_name || rule?.category?.category_name || rule?.category_name || rule?.category || "lease_charge";
    const frequency = normalizeText(rule?.frequency) || "yearly";

    return [{
      org_id: lease.org_id,
      portfolio_id: property?.portfolio_id || null,
      property_id: lease.property_id,
      building_id: lease.building_id || null,
      unit_id: lease.unit_id || null,
      lease_id: lease.id,
      tenant_id: lease.tenant_id || null,
      tenant_name: tenantName,
      category: categoryName,
      expense_subcategory: rule?.category?.subcategory_name || null,
      amount,
      classification: recoveryStatus === "conditional" ? "conditional" : "recoverable",
      recovery_status: recoveryStatus,
      vendor: tenantName,
      vendor_name: tenantName,
      fiscal_year: fiscalYear,
      month,
      date: expenseDate,
      expense_date: expenseDate,
      source: "lease_import",
      source_type: "lease_import",
      rule_source: "lease",
      recovery_rule_id: rule.id,
      allocation_type: "direct",
      allocation_method: "direct",
      is_controllable: Boolean(rule.is_controllable),
      approval_status: recoveryStatus === "conditional" ? "needs_review" : "approved",
      review_status: recoveryStatus === "conditional" ? "needs_review" : "approved",
      confidence_score: asNumberOrNull(rule.confidence) ?? 0.85,
      description: `${rule?.category?.category_name || "Lease"} ${frequency} charge imported from approved lease rule`,
      evidence_text: rule.source || null,
      evidence_page_number: rule?.clauses?.[0]?.page_number ?? null,
      billing_period_start: lease.start_date || expenseDate,
      billing_period_end: lease.end_date || null,
      classification_updated_at: new Date().toISOString(),
    }];
  });
}

function shouldUpdateExpense(existingExpense, payload) {
  const comparableFields = [
    "org_id",
    "portfolio_id",
    "property_id",
    "building_id",
    "unit_id",
    "lease_id",
    "tenant_id",
    "tenant_name",
    "category",
    "expense_subcategory",
    "amount",
    "classification",
    "recovery_status",
    "vendor",
    "vendor_name",
    "fiscal_year",
    "month",
    "date",
    "expense_date",
    "source",
    "source_type",
    "rule_source",
    "recovery_rule_id",
    "allocation_type",
    "allocation_method",
    "is_controllable",
    "description",
    "approval_status",
    "confidence_score",
    "evidence_text",
    "evidence_page_number",
    "billing_period_start",
    "billing_period_end",
  ];

  return comparableFields.some((field) => {
    const existingValue = existingExpense?.[field] ?? null;
    const nextValue = payload?.[field] ?? null;
    return existingValue !== nextValue;
  });
}

function ruleCategoryTokens(rule) {
  return [
    rule?.category?.normalized_key,
    rule?.category?.category_name,
    rule?.category?.subcategory_name,
    rule?.category_name,
  ]
    .map((value) => normalizeText(value).replace(/[^a-z0-9]+/g, "_"))
    .filter(Boolean);
}

function normalizeExpenseCategoryTokens(expense) {
  return [
    expense?.category,
    expense?.expense_subcategory,
    expense?.description,
    expense?.gl_code,
  ]
    .map((value) => normalizeText(value).replace(/[^a-z0-9]+/g, "_"))
    .filter(Boolean);
}

function scoreRuleMatch(expense, rule) {
  const expenseTokens = normalizeExpenseCategoryTokens(expense);
  const ruleTokens = ruleCategoryTokens(rule);

  let score = 0;
  for (const ruleToken of ruleTokens) {
    if (expenseTokens.includes(ruleToken)) score += 100;
    if (expenseTokens.some((token) => token.includes(ruleToken) || ruleToken.includes(token))) score += 35;
  }

  if (expense?.recovery_rule_id && expense.recovery_rule_id === rule.id) score += 150;
  if (expense?.lease_id && expense.lease_id === rule.lease_id) score += 25;
  if (normalizeText(expense?.source_type) === "lease_import") score += 15;
  return score;
}

function servicePeriodOverlaps(expense, lease) {
  const expenseStart = expense?.billing_period_start || expense?.expense_date || expense?.date;
  const expenseEnd = expense?.billing_period_end || expense?.expense_date || expense?.date;
  const leaseStart = lease?.start_date;
  const leaseEnd = lease?.end_date;
  if (!expenseStart || !leaseStart) return true;

  const start = new Date(`${expenseStart}T00:00:00`);
  const end = new Date(`${expenseEnd || expenseStart}T23:59:59`);
  const leaseStartDate = new Date(`${leaseStart}T00:00:00`);
  const leaseEndDate = leaseEnd ? new Date(`${leaseEnd}T23:59:59`) : null;
  if ([start, end, leaseStartDate, leaseEndDate].filter(Boolean).some((value) => Number.isNaN(value.getTime?.()))) return true;
  if (leaseEndDate && start > leaseEndDate) return false;
  if (end < leaseStartDate) return false;
  return true;
}

function scoreScopeMatch(expense, rule) {
  let score = 0;
  if (expense?.lease_id && expense.lease_id === rule?.lease_id) score += 400;
  if (expense?.unit_id && rule?.unit_id && expense.unit_id === rule.unit_id) score += 220;
  if (expense?.building_id && rule?.building_id && expense.building_id === rule.building_id) score += 140;
  if (expense?.property_id && rule?.property_id && expense.property_id === rule.property_id) score += 120;
  return score;
}

function approvedRuleForMatching(rule) {
  return isApprovedLeaseRule(rule);
}

function recoverabilityResultFromRule(rule) {
  const decision = leaseExpenseRuleService.getRecoverableDecision(rule);
  if (rule?.is_excluded) return "excluded";
  if (decision === "yes") return "recoverable";
  if (decision === "conditional") return "conditional";
  return "non_recoverable";
}

function buildMatchReason(expense, rule, score) {
  if (!rule) return "No approved lease expense rule matched this actual expense.";
  const category = rule?.category_name || rule?.expense_category || "expense rule";
  const paymentTreatment = leaseExpenseRuleService.getPaymentTreatment(rule);
  const recoverability = leaseExpenseRuleService.getRecoverableDecision(rule);
  const sourceText = String(rule?.exact_source_text || rule?.source || "").trim();
  const evidenceNote = sourceText ? ` Evidence: "${sourceText.slice(0, 120)}${sourceText.length > 120 ? "..." : ""}"` : "";
  return `Matched approved ${category} rule at score ${score}. Payment treatment: ${paymentTreatment}. Recoverable: ${recoverability}.${evidenceNote}`;
}

function conditionApplied(rule) {
  const source = normalizeText(rule?.source);
  const notes = normalizeText(rule?.notes);
  return CONDITIONAL_KEYWORDS.some((keyword) => source.includes(keyword) || notes.includes(keyword));
}

function isApprovedExpenseRecord(expense, classification = null) {
  // Actual expense input gate for Expense Classification.
  // Accept when any of approval_status / approved_status / review_status / status
  // is explicitly approved (or finalized for "status"). Reject explicit-rejected,
  // draft, needs-review, exception, and lease_rule_amount-sourced rows so that
  // unapproved actuals and rule-amount inserts never enter the classification view.
  // Use the centralized status helpers (src/lib/ruleStatus.js). Review uses
  // the RAW reader because this function treats "reviewed" and "approved"
  // separately (only "approved" passes; "reviewed" alone does not).
  const approval = getEffectiveApprovalStatus(expense);
  const review = getRawReviewStatus(expense);
  const status = normalizeText(expense?.status);
  const exceptionType = normalizeText(expense?.exception_type);
  const source = normalizeText(expense?.source || expense?.source_type || expense?.cam_input_type);

  if (source === "lease_rule_amount") return false;
  if (approval === "rejected" || review === "rejected" || status === "rejected") return false;
  if (approval === "needs_review" || review === "needs_review") return false;
  if (approval === "draft" || review === "draft" || status === "draft") return false;
  if (exceptionType && exceptionType !== "none" && exceptionType !== "resolved") return false;

  if (approval === "approved") return true;
  if (review === "approved") return true;
  if (status === "approved" || status === "finalized") return true;
  // "active" and "executed" are the standard lifecycle states for expenses
  // that have been entered and confirmed in the system but may not have an
  // explicit approval_status field set. Treat them as approved for
  // classification eligibility — consistent with how the workflow summary
  // and lease module treat these statuses.
  if (status === "active" || status === "executed") return true;

  return false;
}

function isPendingExpenseRecord(expense) {
  const status = normalizeText(
    expense?.approval_status ||
    expense?.review_status ||
    expense?.approved_status ||
    expense?.status
  );
  return status !== "approved";
}

function normalizeScopeValue(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized || normalized === "all" || normalized === "null" || normalized === "undefined") {
    return null;
  }
  return value;
}

function normalizeRecoverabilityScope(scope = {}) {
  return {
    property_id: normalizeScopeValue(scope.property_id),
    building_id: normalizeScopeValue(scope.building_id),
    unit_id: normalizeScopeValue(scope.unit_id),
    lease_id: normalizeScopeValue(scope.lease_id),
    tenant_id: normalizeScopeValue(scope.tenant_id),
    fiscal_year: normalizeScopeValue(scope.fiscal_year),
  };
}

function isStrictlyApprovedLeaseRule(rule) {
  const approval = normalizeText(rule?.approval_status || rule?.approved_status);
  const review = normalizeText(rule?.review_status);
  return approval === "approved" && review === "approved";
}

function approvedRuleState(rule) {
  const approval = normalizeText(rule?.approval_status);
  const review = normalizeText(rule?.review_status) === "reviewed" ? "approved" : normalizeText(rule?.review_status);
  const status = normalizeText(rule?.status);
  const rowStatus = normalizeText(rule?.row_status);

  if (["rejected"].includes(approval) || ["rejected"].includes(review) || status === "rejected") return "rejected";
  // Note: "missing_value" means the lease mentions the term but no dollar
  // amount was found. The rule is still valid — it just lacks an estimate.
  // Map to "needs_review" so the reviewer can confirm; do NOT treat as N/A.
  if (rowStatus === "unmapped" || rowStatus === "not_found") return "na";
  if (approval === "approved" && review === "approved") return "approved";
  if (
    [approval, review, status].includes("needs_review")
    || rowStatus === "needs_review"
    || rowStatus === "uncertain"
    || rowStatus === "mapped"
    || rowStatus === "missing_value"
  ) return "needs_review";
  return "draft";
}

function isApprovedLeaseRule(rule) {
  // Classification + matching must only consume APPROVED lease expense rules.
  // Accept on: approval_status === approved, OR review_status === approved/reviewed,
  // OR status === approved/finalized (whichever field the row actually carries).
  // Reject explicit rejections, unmapped/not-found row statuses, or rule_status === rejected.
  // "missing_value" is NOT a rejection — a clause-supported rule with no
  // dollar amount is still a valid lease expense rule.
  const approval = normalizeText(rule?.approval_status || rule?.approved_status);
  const review = normalizeText(rule?.review_status);
  const status = normalizeText(rule?.status || rule?.rule_status);
  const rowStatus = normalizeText(rule?.row_status);

  if (approval === "rejected" || review === "rejected" || status === "rejected") return false;
  if (["rejected", "unmapped", "not_found"].includes(rowStatus)) return false;
  if (rule?.is_excluded === true) return false;

  if (approval === "approved") return true;
  if (review === "approved" || review === "reviewed") return true;
  if (status === "approved" || status === "finalized") return true;

  return false;
}

function expenseMatchesScope(expense, scope = {}) {
  const { property_id, building_id, unit_id, lease_id, tenant_id, fiscal_year } = normalizeRecoverabilityScope(scope);

  const matchesLease = lease_id && String(expense.lease_id) === String(lease_id);

  if (!matchesLease) {
    if (property_id && expense.property_id !== property_id) return false;
    if (building_id && expense.building_id !== building_id) return false;
    if (unit_id && expense.unit_id !== unit_id) return false;
    if (lease_id && expense.lease_id !== lease_id) return false;
    if (tenant_id && expense.tenant_id !== tenant_id) return false;
  }

  const status = normalizeText(expense?.status);
  if (["deleted", "void", "voided", "archived"].includes(status)) return false;

  if (fiscal_year) {
    const candidateDate =
      expense.expense_date ||
      expense.date ||
      expense.service_period_start ||
      expense.period ||
      null;

    if (candidateDate) {
      const parsedYear = new Date(`${candidateDate}T00:00:00`).getFullYear();
      if (Number.isFinite(parsedYear) && String(parsedYear) !== String(fiscal_year)) return false;
    }
  }

  return true;
}

function leaseMatchesScope(lease, scope = {}) {
  const { property_id, building_id, unit_id, lease_id, tenant_id, fiscal_year } = normalizeRecoverabilityScope(scope);
  if (lease_id && lease.id !== lease_id) return false;
  if (tenant_id && lease.tenant_id !== tenant_id) return false;
  if (property_id && lease.property_id !== property_id) return false;
  if (unit_id && lease.unit_id !== unit_id) return false;
  if (building_id) {
    const leaseBuildingId = lease.building_id || null;
    if (leaseBuildingId && leaseBuildingId !== building_id) return false;
  }
  if (!leaseOverlapsFiscalYear(lease, fiscal_year ? Number(fiscal_year) : null)) return false;
  return true;
}

function ruleMatchesScope(rule, lease, scope = {}) {
  const { property_id, building_id, unit_id, lease_id, tenant_id, fiscal_year } = normalizeRecoverabilityScope(scope);

  if (!isApprovedLeaseRule(rule)) return false;
  if (approvedRuleState(rule) === "na" || approvedRuleState(rule) === "rejected") return false;

  const effectiveLeaseId = rule.lease_id || lease?.id || rule.rule_set?.lease_id || null;
  const effectiveTenantId = rule.tenant_id || lease?.tenant_id || rule.rule_set?.tenant_id || null;
  const effectivePropertyId = rule.property_id || lease?.property_id || rule.rule_set?.property_id || null;
  const effectiveBuildingId = rule.building_id || lease?.building_id || rule.rule_set?.building_id || null;
  const effectiveUnitId = rule.unit_id || lease?.unit_id || rule.rule_set?.unit_id || null;

  const matchesLease = lease_id && String(effectiveLeaseId) === String(lease_id);

  if (!matchesLease) {
    if (property_id && effectivePropertyId !== property_id) return false;
    if (building_id && effectiveBuildingId !== building_id) return false;
    if (unit_id && effectiveUnitId !== unit_id) return false;
    if (lease_id && effectiveLeaseId !== lease_id) return false;
    if (tenant_id && effectiveTenantId !== tenant_id) return false;
  }

  if (fiscal_year && lease && !leaseOverlapsFiscalYear(lease, Number(fiscal_year))) {
    return false;
  }

  return true;
}



function approvedLeaseForExpenseLink(lease) {
  return ["approved", "active", "executed", "budget_ready"].includes(normalizeLeaseStatus(lease?.status));
}

function candidateLeaseLinkScore(expense, lease) {
  let score = 0;
  if (expense?.lease_id && lease?.id === expense.lease_id) score += 1000;
  if (expense?.tenant_id && lease?.tenant_id === expense.tenant_id) score += 500;
  if (expense?.unit_id && lease?.unit_id === expense.unit_id) score += 350;
  if (expense?.building_id && lease?.building_id === expense.building_id) score += 200;
  if (expense?.property_id && lease?.property_id === expense.property_id) score += 100;
  if (servicePeriodOverlaps({ ...expense, expense_date: expenseServiceDate(expense) }, lease)) score += 50;
  return score;
}

function findMatchingLeasesForExpense(expense, leases = []) {
  return (leases || [])
    .filter((lease) => {
      if (!approvedLeaseForExpenseLink(lease)) return false;
      if (expense?.property_id && lease?.property_id !== expense.property_id) return false;
      if (expense?.building_id && lease?.building_id && lease.building_id !== expense.building_id) return false;
      if (expense?.unit_id && lease?.unit_id && lease.unit_id !== expense.unit_id) return false;
      if (expense?.tenant_id && lease?.tenant_id && lease.tenant_id !== expense.tenant_id) return false;
      return servicePeriodOverlaps({ ...expense, expense_date: expenseServiceDate(expense) }, lease);
    })
    .sort((left, right) => candidateLeaseLinkScore(expense, right) - candidateLeaseLinkScore(expense, left));
}

function getExpenseTenantId(expense, lease = null, unit = null) {
  if (expense?.tenant_id) return expense.tenant_id;
  if (lease?.tenant_id) return lease.tenant_id;
  if (unit?.tenant_id) return unit.tenant_id;
  return null;
}

function applyLeaseLinkToExpense(expense, lease) {
  if (!lease) return { ...expense };
  return {
    ...expense,
    lease_id: expense?.lease_id || lease.id || null,
    tenant_id: getExpenseTenantId(expense, lease),
    tenant_name: expense?.tenant_name || lease.tenant_name || null,
    property_id: expense?.property_id || lease.property_id || null,
    building_id: expense?.building_id || lease.building_id || null,
    unit_id: expense?.unit_id || lease.unit_id || null,
  };
}

function classificationMatchesScope(classification, scope = {}) {
  const { property_id, building_id, unit_id, lease_id, tenant_id, fiscal_year } = normalizeRecoverabilityScope(scope);

  const cProp = classification.property_id || classification.expense?.property_id || classification.lease?.property_id || null;
  const cBldg = classification.building_id || classification.expense?.building_id || classification.lease?.building_id || null;
  const cUnit = classification.unit_id || classification.expense?.unit_id || classification.lease?.unit_id || null;
  const cLease = classification.lease_id || classification.expense?.lease_id || null;
  const cTenant = classification.tenant_id || classification.expense?.tenant_id || classification.lease?.tenant_id || null;

  if (property_id && cProp && cProp !== property_id) return false;
  if (building_id && cBldg && cBldg !== building_id) return false;
  if (unit_id && cUnit && cUnit !== unit_id) return false;
  if (lease_id && cLease && cLease !== lease_id) return false;
  if (tenant_id && cTenant && cTenant !== tenant_id) return false;

  if (fiscal_year) {
    const start = normalizeDateCandidate(classification.service_period_start || classification.expense_date || classification.classified_at);
    const end = normalizeDateCandidate(classification.service_period_end || classification.service_period_start || classification.expense_date || classification.classified_at);
    const yearStart = new Date(Number(fiscal_year), 0, 1);
    const yearEnd = new Date(Number(fiscal_year), 11, 31, 23, 59, 59);
    if (start && start > yearEnd) return false;
    if (end && end < yearStart) return false;
  }

  return true;
}

function buildClassificationKey({ orgId, expenseId, leaseExpenseRuleId = null, period = null } = {}) {
  if (expenseId) return [orgId || "", expenseId, leaseExpenseRuleId || "unmatched"].join(":");
  if (leaseExpenseRuleId) return [orgId || "", "missing_actual", leaseExpenseRuleId, period || ""].join(":");
  return null;
}

function buildAmountBuckets(actualAmount, recoverabilityResult) {
  const amount = toNumber(actualAmount);
  return {
    recoverable_amount: recoverabilityResult === "recoverable" ? amount : 0,
    non_recoverable_amount: recoverabilityResult === "non_recoverable" ? amount : 0,
    conditional_amount: recoverabilityResult === "conditional" ? amount : 0,
    excluded_amount: recoverabilityResult === "excluded" ? amount : 0,
  };
}

function buildPlainEnglishReason({ expense, rule, recoverabilityResult, fallbackReason }) {
  const expenseLabel = String(
    expense?.category ||
    expense?.expense_subcategory ||
    rule?.category_name ||
    rule?.expense_category ||
    "expense"
  ).replace(/_/g, " ");

  if (!rule) {
    return `This ${expenseLabel} expense needs review because no approved lease rule matched this category.`;
  }

  const paymentTreatment = normalizeText(leaseExpenseRuleService.getPaymentTreatment(rule));
  if (paymentTreatment === "included_in_base_rent") {
    return `This ${expenseLabel} expense is non-recoverable because the approved lease rule says it is included in base rent.`;
  }

  if (recoverabilityResult === "recoverable") {
    return `This ${expenseLabel} expense is recoverable because the approved lease rule allows recovery from the tenant.`;
  }

  if (recoverabilityResult === "conditional") {
    return `This ${expenseLabel} expense needs review because the approved lease rule applies a cap, threshold, or other condition before recovery.`;
  }

  if (recoverabilityResult === "excluded") {
    return `This ${expenseLabel} expense is excluded because the matched lease rule is marked not applicable or excluded.`;
  }

  if (recoverabilityResult === "non_recoverable") {
    return `This ${expenseLabel} expense is non-recoverable because the approved lease rule does not allow tenant recovery.`;
  }

  return fallbackReason || `This ${expenseLabel} expense needs review before it can move forward.`;
}

function buildClassificationNextStep({
  classificationStatus,
  recoverabilityResult,
  sentToCam,
  camEligible,
  camStatus,
} = {}) {
  if (sentToCam) return "Sent to CAM";
  if (normalizeText(camStatus) === "cam_ready") return "CAM Ready";
  if (classificationStatus === "finalized" && camEligible === "yes" && recoverabilityResult === "recoverable") {
    return "Send to CAM";
  }
  if (classificationStatus === "finalized") return "Ready for projection";
  if (classificationStatus === "conditional") return "Resolve condition";
  if (classificationStatus === "exception" || classificationStatus === "unmatched" || recoverabilityResult === "needs_review") {
    return "Review exception";
  }
  return "Finalize row";
}

function classificationSortTime(row) {
  return Date.parse(
    row?.sent_to_cam_at ||
    row?.updated_at ||
    row?.classified_at ||
    row?.reviewed_at ||
    row?.finalized_at ||
    ""
  );
}

function preferExpenseClassificationRecord(current, candidate) {
  if (!current) return candidate;
  if (!candidate) return current;

  const currentSent = isClassificationSentToCam(current);
  const candidateSent = isClassificationSentToCam(candidate);
  if (currentSent !== candidateSent) {
    return candidateSent ? candidate : current;
  }

  const currentTime = classificationSortTime(current);
  const candidateTime = classificationSortTime(candidate);
  if (!Number.isFinite(currentTime)) return candidate;
  if (!Number.isFinite(candidateTime)) return current;
  return candidateTime >= currentTime ? candidate : current;
}

// Treat any of the lease-expense-rule supporting tables not being deployed
// as "no rules" rather than throwing — this code runs on every lease save
// and approval, and a missing optional table shouldn't break the user's
// happy path.







const EXPENSE_CLASSIFICATION_UUID_COLUMNS = new Set([
  "id",
  "org_id",
  "expense_id",
  "actual_expense_id",
  "property_id",
  "building_id",
  "unit_id",
  "lease_id",
  "tenant_id",
  "rule_set_id",
  "recovery_rule_id",
  "linked_expense_rule_id",
  "lease_expense_rule_id",
  "approved_by",
  "reviewed_by",
  "sent_to_cam_by",
  "manual_cam_reviewed_by",
  "cam_pool_id",
]);

const BASELINE_EXPENSE_CLASSIFICATION_COLUMNS = new Set([
  "id",
  "org_id",
  "expense_id",
  "property_id",
  "building_id",
  "unit_id",
  "lease_id",
  "tenant_id",
  "rule_set_id",
  "recovery_rule_id",
  "recovery_status",
  "allocation_method",
  "cap_applied",
  "exclusion_applied",
  "condition_applied",
  "condition_reason",
  "rule_source",
  "confidence_score",
  "evidence_text",
  "evidence_page_number",
  "approved_status",
  "notes",
  "classified_at",
  "approved_by",
  "approved_at",
  "created_at",
  "updated_at",
]);

const missingExpenseClassificationColumns = new Set();

const EXPENSE_CLASSIFICATION_WORKFLOW_COLUMNS = [
  "classification_key",
  "actual_expense_id",
  "lease_expense_rule_id",
  "linked_expense_rule_id",
  "recoverability_result",
  "recovery_reason",
  "cam_eligible",
  "recovery_method",
  "cam_pool_id",
  "category",
  "subcategory",
  "amount",
  "service_period_start",
  "service_period_end",
  "classification_status",
  "exception_type",
  "reviewed_by",
  "reviewed_at",
  "finalized_at",
  "recoverable_amount",
  "non_recoverable_amount",
  "conditional_amount",
  "excluded_amount",
  "sent_to_cam",
  "sent_to_cam_at",
  "sent_to_cam_by",
  "allocation_basis",
  "next_step",
  "row_type",
];

const CAM_WORKFLOW_COLUMNS = [
  "cam_status",
  "cam_source",
  "cam_input_type",
  "manual_cam_reviewed",
  "manual_cam_reason",
  "manual_cam_reviewed_by",
  "manual_cam_reviewed_at",
];

for (const column of [...EXPENSE_CLASSIFICATION_WORKFLOW_COLUMNS, ...CAM_WORKFLOW_COLUMNS]) {
  BASELINE_EXPENSE_CLASSIFICATION_COLUMNS.add(column);
}

function normalizeExpenseClassificationPayload(payload = {}) {
  const normalized = compactDefined(payload);
  for (const column of EXPENSE_CLASSIFICATION_UUID_COLUMNS) {
    if (column in normalized) {
      normalized[column] = cleanUuid(normalized[column]);
    }
  }
  if (!normalized.id) delete normalized.id;
  normalized.expense_id = cleanUuid(normalized.expense_id || normalized.actual_expense_id);
  normalized.actual_expense_id = cleanUuid(normalized.actual_expense_id || normalized.expense_id);
  return normalized;
}

function pickColumns(row = {}, allowedColumns = new Set()) {
  return Object.fromEntries(
    Object.entries(row).filter(([key, value]) =>
      allowedColumns.has(key) &&
      !missingExpenseClassificationColumns.has(key) &&
      value !== undefined
    )
  );
}

async function selectExpenseClassifications({ columns = [], apply = (query) => query } = {}) {
  if (!supabase || columns.length === 0) return [];

  let query = supabase.from("expense_classifications").select("*");
  query = apply(query);

  const { data, error } = await query;
  if (error) {
    throw error;
  }

  return (data || []).map((row) =>
    Object.fromEntries(
      columns.map((column) => [column, row?.[column]])
    )
  );
}

async function listWorkflowEntityRows(entityName) {
  const orgId = await getCurrentOrgId({ allowSuperAdminGlobal: true });
  if (orgId === "__none__") return [];

  if (!supabase) {
    return createEntityService(entityName).list();
  }

  let query = supabase.from(resolveTableName(entityName)).select("*");
  if (orgId && orgId !== "__none__") {
    query = query.eq("org_id", orgId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function fetchApprovedRuleArtifacts(leaseIds = []) {
  if (!supabase || leaseIds.length === 0) {
    return { ruleSets: [], rules: [], categories: [] };
  }

  const { data: ruleSets, error: ruleSetError } = await supabase
    .from("lease_expense_rule_sets")
    .select("id, lease_id, status, property_id, version")
    .in("lease_id", leaseIds)
    .not("status", "eq", "archived")
    .order("version", { ascending: false });

  if (ruleSetError) {
    const query = `select("id, lease_id, status, property_id, version")`;
    console.error("[TASK 1] Exact Supabase error from lease_expense_rule_sets:", {
      code: ruleSetError?.code,
      message: ruleSetError?.message,
      details: ruleSetError?.details,
      query: query,
      filters: `in("lease_id", [${leaseIds.join(",")}])`,
      errorObj: ruleSetError
    });
    if (isMissingExpenseRuleTable(ruleSetError)) {
      console.warn("[expenseService] lease_expense_rule_sets table missing — treating as no rules.");
      return { ruleSets: [], rules: [], categories: [] };
    }
    throw ruleSetError;
  }
  if (!ruleSets?.length) return { ruleSets: [], rules: [], categories: [] };

  const ruleSetsByLease = new Map();
  for (const ruleSet of ruleSets || []) {
    const existing = ruleSetsByLease.get(ruleSet.lease_id) || [];
    existing.push(ruleSet);
    ruleSetsByLease.set(ruleSet.lease_id, existing);
  }

  const { data: rules, error: rulesError } = await supabase
    .from("lease_expense_rules")
    .select("*")
    .in("rule_set_id", (ruleSets || []).map((ruleSet) => ruleSet.id).filter(Boolean));

  if (rulesError) {
    if (isMissingExpenseRuleTable(rulesError)) {
      console.warn("[expenseService] lease_expense_rules table missing — treating as no rules.");
      return { ruleSets: [], rules: [], categories: [] };
    }
    throw rulesError;
  }

  const rulesBySet = new Map();
  for (const rule of rules || []) {
    const existing = rulesBySet.get(rule.rule_set_id) || [];
    existing.push(rule);
    rulesBySet.set(rule.rule_set_id, existing);
  }

  const latestRuleSets = [...ruleSetsByLease.values()]
    .map((setsForLease) => leaseExpenseRuleService.pickPreferredRuleSetWithApprovedChildren(setsForLease, rulesBySet))
    .filter(Boolean);
  const ruleSetIds = latestRuleSets.map((ruleSet) => ruleSet.id);
  const selectedRuleSetIds = new Set(ruleSetIds);
  const selectedRules = (rules || []).filter((rule) => selectedRuleSetIds.has(rule.rule_set_id));

  const ruleIds = selectedRules.map((rule) => rule.id);
  const categoryIds = [...new Set(selectedRules.map((rule) => rule.expense_category_id).filter(Boolean))];

  const [{ data: values, error: valuesError }, { data: clauses, error: clausesError }, { data: categories, error: categoriesError }] = await Promise.all([
    ruleIds.length > 0
      ? supabase.from("lease_expense_values").select("*").in("rule_id", ruleIds)
      : Promise.resolve({ data: [], error: null }),
    ruleIds.length > 0
      ? supabase.from("lease_expense_rule_clauses").select("*").in("lease_expense_rule_id", ruleIds)
      : Promise.resolve({ data: [], error: null }),
    categoryIds.length > 0
      ? supabase.from("expense_categories").select("*").in("id", categoryIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  // Optional supporting tables: missing → empty, not throw.
  if (valuesError && !isMissingExpenseRuleTable(valuesError)) throw valuesError;
  if (clausesError && !isMissingExpenseRuleTable(clausesError)) throw clausesError;
  if (categoriesError && !isMissingExpenseRuleTable(categoriesError)) throw categoriesError;
  const safeValues = valuesError ? [] : (values || []);
  const safeClauses = clausesError ? [] : (clauses || []);
  const safeCategories = categoriesError ? [] : (categories || []);

  const valuesByRuleId = new Map(safeValues.map((value) => [value.rule_id, value]));
  const clausesByRuleId = new Map();
  safeClauses.forEach((clause) => {
    const existing = clausesByRuleId.get(clause.lease_expense_rule_id) || [];
    existing.push(clause);
    clausesByRuleId.set(clause.lease_expense_rule_id, existing);
  });

  const rulesWithRelations = selectedRules.map((rule) => ({
    ...rule,
    lease_id: latestRuleSets.find((ruleSet) => ruleSet.id === rule.rule_set_id)?.lease_id || null,
    ...valuesByRuleId.get(rule.id),
    clauses: clausesByRuleId.get(rule.id) || [],
  }));

  return {
    ruleSets: latestRuleSets || [],
    rules: rulesWithRelations,
    categories: safeCategories,
  };
}

async function fetchRuleSetScopeRows(ruleSetIds = []) {
  if (!supabase || ruleSetIds.length === 0) return [];
  try {
    const { data, error } = await supabase
      .from("lease_expense_rule_sets")
      .select("id, lease_id, property_id, building_id, unit_id, tenant_id")
      .in("id", ruleSetIds);

    if (error) {
      if (isMissingExpenseRuleTable(error)) {
        console.warn("[expenseService] lease_expense_rule_sets scope lookup missing — continuing without rule_set scope hydration.");
        return [];
      }
      throw error;
    }

    return data || [];
  } catch (error) {
    if (isMissingExpenseRuleTable(error)) {
      console.warn("[expenseService] lease_expense_rule_sets scope lookup missing — continuing without rule_set scope hydration.");
      return [];
    }
    throw error;
  }
}

function hydrateClassificationRule(rule, { leaseById = new Map(), unitById = new Map(), ruleSetById = new Map() } = {}) {
  const ruleSet = ruleSetById.get(rule.rule_set_id) || null;
  const effectiveLeaseId = rule.lease_id || ruleSet?.lease_id || null;
  const lease = effectiveLeaseId ? leaseById.get(effectiveLeaseId) || null : null;
  const effectiveUnitId = rule.unit_id || lease?.unit_id || ruleSet?.unit_id || null;
  const unit = effectiveUnitId ? unitById.get(effectiveUnitId) || null : null;

  return {
    ...rule,
    lease_id: effectiveLeaseId,
    property_id: rule.property_id || lease?.property_id || ruleSet?.property_id || null,
    building_id: rule.building_id || lease?.building_id || unit?.building_id || ruleSet?.building_id || null,
    unit_id: effectiveUnitId,
    tenant_id: rule.tenant_id || lease?.tenant_id || ruleSet?.tenant_id || null,
    rule_set: rule.rule_set || ruleSet,
  };
}

async function fetchRuleSetScopeRowsCompat(ruleSetIds = []) {
  if (!supabase || ruleSetIds.length === 0) return [];
  const { data, error } = await supabase
    .from("lease_expense_rule_sets")
    .select("*")
    .in("id", ruleSetIds);

  if (error) {
    if (isMissingExpenseRuleTable(error)) {
      console.warn("[expenseService] lease_expense_rule_sets scope lookup missing — continuing without rule_set scope hydration.");
      return [];
    }
    throw error;
  }

  return (data || []).map((row) => ({
    id: row.id,
    lease_id: row.lease_id,
    property_id: row.property_id ?? null,
    building_id: row.building_id ?? null,
    unit_id: row.unit_id ?? null,
    tenant_id: row.tenant_id ?? null,
  }));
}

function summarizeApprovedRulesBy(rules = [], key) {
  const counts = {};
  for (const rule of rules) {
    const value = rule?.[key];
    if (!value) continue;
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

async function fetchApprovedClassificationRules(scope = {}) {
  const normalizedScope = normalizeRecoverabilityScope(scope);
  const orgId = await getCurrentOrgId({ allowSuperAdminGlobal: true });
  if (!supabase || orgId === "__none__") {
    return {
      scope: normalizedScope,
      approvedRules: [],
      allApprovedRules: [],
      leaseById: new Map(),
    };
  }

  let query = supabase
    .from("lease_expense_rules")
    .select("*")
    .eq("approval_status", "approved")
    .eq("review_status", "approved")
    .limit(5000);

  const { data, error } = await query;
  if (error) {
    console.error("[ExpenseRecoverability] lease_expense_rules direct query failed", {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
    throw error;
  }

  const [leases, units, ruleSetRows] = await Promise.all([
    listWorkflowEntityRows("Lease"),
    listWorkflowEntityRows("Unit").catch(() => []),
    fetchRuleSetScopeRowsCompat([...new Set((data || []).map((rule) => rule.rule_set_id).filter(Boolean))]),
  ]);

  const leaseById = new Map((leases || []).map((lease) => [lease.id, lease]));
  const unitById = new Map((units || []).map((unit) => [unit.id, unit]));
  const ruleSetById = new Map((ruleSetRows || []).map((ruleSet) => [ruleSet.id, ruleSet]));
  const accessibleLeaseIds = new Set((leases || []).map((lease) => lease.id).filter(Boolean));
  const accessiblePropertyIds = new Set((leases || []).map((lease) => lease.property_id).filter(Boolean));
  const accessibleTenantIds = new Set((leases || []).map((lease) => lease.tenant_id).filter(Boolean));

  const allApprovedRules = (data || [])
    .filter((rule) => isStrictlyApprovedLeaseRule(rule))
    .map((rule) => hydrateClassificationRule(rule, { leaseById, unitById, ruleSetById }));

  const accessibleApprovedRules = allApprovedRules.filter((rule) => {
    const effectiveLeaseId = rule.lease_id || rule.rule_set?.lease_id || null;
    if (effectiveLeaseId && accessibleLeaseIds.has(effectiveLeaseId)) return true;
    if (orgId && rule.org_id && String(rule.org_id) === String(orgId)) return true;
    if (rule.property_id && accessiblePropertyIds.has(rule.property_id)) return true;
    if (rule.tenant_id && accessibleTenantIds.has(rule.tenant_id)) return true;
    return false;
  });

  const approvedRules = accessibleApprovedRules.filter((rule) =>
    ruleMatchesScope(rule, leaseById.get(rule.lease_id) || null, normalizedScope)
  );

  const draftButReviewedRules = (data || [])
    .filter((rule) => normalizeText(rule?.review_status) === "approved" && normalizeText(rule?.approval_status) !== "approved")
    .map((rule) => hydrateClassificationRule(rule, { leaseById, unitById, ruleSetById }))
    .filter((rule) => {
      const effectiveLeaseId = rule.lease_id || rule.rule_set?.lease_id || null;
      return Boolean(effectiveLeaseId && accessibleLeaseIds.has(effectiveLeaseId));
    });

  return {
    scope: normalizedScope,
    approvedRules,
    allApprovedRules: accessibleApprovedRules,
    leaseById,
    diagnostics: {
      rawApprovedRuleCount: allApprovedRules.length,
      accessibleApprovedRuleCount: accessibleApprovedRules.length,
      reviewedButDraftCount: draftButReviewedRules.length,
      reviewedButDraftRuleIds: draftButReviewedRules.slice(0, 10).map((rule) => rule.id),
    },
  };
}

async function upsertExpenseClassification(payload, { expensePatch = null } = {}) {
  if (!supabase || !payload?.org_id) return;
  if (!payload?.expense_id && !payload?.actual_expense_id && !payload?.lease_expense_rule_id) return;
  try {
    const hasExpense = !!(payload.expense_id || payload.actual_expense_id);
    const hasRule = !!(payload.lease_expense_rule_id || payload.linked_expense_rule_id || payload.recovery_rule_id);
    const rowType = payload.row_type || (
      (hasExpense && hasRule) ? "matched_classification" :
        (hasExpense && !hasRule) ? "actual_missing_rule" :
          (!hasExpense && hasRule) ? "rule_missing_actual" : "unknown"
    );

    const nextPayload = normalizeExpenseClassificationPayload({
      ...payload,
      expense_id: payload.expense_id || payload.actual_expense_id || null,
      actual_expense_id: payload.actual_expense_id || payload.expense_id || null,
      row_type: rowType,
    });

    // The consistency-critical case (a classification tied to a real
    // expense) is gated server-side via persist-expense-classification: the
    // client still computes the full match/score (unchanged), but the edge
    // function re-checks CAM-readiness/recoverability consistency against
    // the expense/rule before persisting, and audits every write. See
    // docs/server-owned-workflow-pattern.md. The "rule_missing_actual"
    // bookkeeping case (a rule row with no linked expense at all) has no
    // expense to gate against and is left on the direct upsert below.
    //
    // Phase 6X-1: when expensePatch is provided, the same RPC call also
    // persists the paired `expenses` columns (classification/recovery_status)
    // in the same transaction as the classification upsert — replacing what
    // used to be a second, separate, non-transactional direct write.
    if (hasExpense) {
      const linkedRuleId = nextPayload.lease_expense_rule_id || nextPayload.linked_expense_rule_id || nextPayload.recovery_rule_id || null;
      const patch = { ...nextPayload };
      delete patch.org_id;
      delete patch.expense_id;
      delete patch.actual_expense_id;
      delete patch.lease_expense_rule_id;
      delete patch.linked_expense_rule_id;
      delete patch.recovery_rule_id;
      delete patch.recovery_status;
      delete patch.recoverability_result;
      delete patch.cam_eligible;
      delete patch.cam_status;
      delete patch.sent_to_cam;

      const result = await invokeEdgeFunction("persist-expense-classification", {
        expense_id: nextPayload.expense_id,
        linked_expense_rule_id: linkedRuleId,
        recovery_status: nextPayload.recovery_status,
        recoverability_result: nextPayload.recoverability_result,
        cam_eligible: nextPayload.cam_eligible,
        cam_status: nextPayload.cam_status,
        sent_to_cam: Boolean(nextPayload.sent_to_cam),
        ...(expensePatch && Object.keys(expensePatch).length > 0 ? { expense_patch: expensePatch } : {}),
        ...patch,
      });
      clearCache();
      return result?.row ?? null;
    }

    const baselinePayload = pickColumns(nextPayload, BASELINE_EXPENSE_CLASSIFICATION_COLUMNS);
    const conflictTargets = ["classification_key"];

    for (const onConflict of conflictTargets) {
      const attemptPayload = { ...baselinePayload };

      while (Object.keys(attemptPayload).length > 0) {
        const { data, error } = await supabase
          .from("expense_classifications")
          .upsert(attemptPayload, { onConflict })
          .select("*")
          .maybeSingle();
        if (!error) return data;

        const conflictError = String(error?.message || error?.details || "").toLowerCase();
        if (
          error?.code === "42P10" ||
          conflictError.includes("no unique") ||
          conflictError.includes("no constraint")
        ) {
          break;
        }

        const missingColumn = extractMissingColumn(error);
        if (!isMissingColumnError(error) || !missingColumn || !(missingColumn in attemptPayload)) {
          throw error;
        }
        missingExpenseClassificationColumns.add(missingColumn);
        delete attemptPayload[missingColumn];
      }
    }
  } catch (error) {
    console.warn("[expenseService] expense classification persistence warning:", error);
  }
}

async function fetchExistingExpenseClassifications(expenseIds = []) {
  if (!supabase || expenseIds.length === 0) return [];
  try {
    return await selectExpenseClassificationsForExpenseIds(expenseIds, [
      "id",
      "org_id",
      "classification_key",
      "expense_id",
      "actual_expense_id",
      "lease_expense_rule_id",
      "property_id",
      "building_id",
      "unit_id",
      "lease_id",
      "tenant_id",
      "category",
      "subcategory",
      "amount",
      "service_period_start",
      "service_period_end",
      "cam_eligible",
      "recovery_method",
      "recovery_reason",
      "rule_source",
      "evidence_text",
      "notes",
      "confidence_score",
      "recoverability_result",
      "recovery_status",
      "exception_type",
      "classification_status",
      "row_type",
      "recoverable_amount",
      "non_recoverable_amount",
      "conditional_amount",
      "excluded_amount",
      "sent_to_cam",
      "sent_to_cam_at",
      "sent_to_cam_by",
      "cam_status",
      "cam_source",
      "cam_input_type",
      "manual_cam_reviewed",
      "manual_cam_reason",
      "manual_cam_reviewed_by",
      "manual_cam_reviewed_at",
      "next_step",
      "classified_at",
      "finalized_at",
      "reviewed_at",
      "updated_at",
      "approved_status"
    ]);
  } catch (error) {
    console.error("[TASK 1] Exact Supabase error from expense_classifications:", {
      code: error?.code,
      message: error?.message,
      details: error?.details,
      filters: `expenseIds: ${expenseIds.join(",")}`,
      errorObj: error
    });
    if (isMissingExpenseRuleTable(error)) {
      console.warn("[expenseService] expense_classifications table missing — treating as no persisted classifications.");
      return [];
    }
    throw error;
  }
}

async function _legacySelectExpenseClassificationsForExpenseIds(expenseIds = [], columns = []) {
  if (!supabase || expenseIds.length === 0 || columns.length === 0) return [];

  const cleanExpenseIds = expenseIds.filter(Boolean);
  const expenseFilter = cleanExpenseIds.join(",");

  try {
    return await selectExpenseClassifications({
      columns,
      apply: (query) => query.or(`expense_id.in.(${expenseFilter}),actual_expense_id.in.(${expenseFilter})`),
    });
  } catch (error) {
    const missingColumn = extractMissingColumn(error);
    if (!isMissingColumnError(error) || !["expense_id", "actual_expense_id"].includes(missingColumn)) {
      throw error;
    }

    const fallbackColumn = missingColumn === "expense_id" ? "actual_expense_id" : "expense_id";
    try {
      return await selectExpenseClassifications({
        columns,
        apply: (query) => query.in(fallbackColumn, cleanExpenseIds),
      });
    } catch (fallbackError) {
      const secondMissing = extractMissingColumn(fallbackError);
      if (isMissingColumnError(fallbackError) && secondMissing === fallbackColumn) {
        console.warn("[expenseService] expense_classifications id-link columns missing — treating as no persisted classifications.");
        return [];
      }
      throw fallbackError;
    }
  }
}

async function selectExpenseClassificationsForExpenseIds(expenseIds = [], columns = []) {
  if (!supabase || expenseIds.length === 0 || columns.length === 0) return [];

  const cleanExpenseIds = expenseIds.filter(Boolean);
  const mergedRows = new Map();
  let attemptedAtLeastOneLinkColumn = false;

  for (const linkColumn of ["expense_id", "actual_expense_id"]) {
    try {
      const rows = await selectExpenseClassifications({
        columns,
        apply: (query) => query.in(linkColumn, cleanExpenseIds),
      });
      attemptedAtLeastOneLinkColumn = true;

      for (const row of rows || []) {
        const dedupeKey =
          row?.id ||
          row?.classification_key ||
          `${row?.expense_id || row?.actual_expense_id || "unknown"}:${row?.lease_expense_rule_id || row?.recovery_rule_id || "no-rule"}`;
        if (!mergedRows.has(dedupeKey)) {
          mergedRows.set(dedupeKey, row);
        }
      }
    } catch (error) {
      const missingColumn = extractMissingColumn(error);
      if (isMissingColumnError(error) && missingColumn === linkColumn) {
        continue;
      }
      throw error;
    }
  }

  if (!attemptedAtLeastOneLinkColumn) {
    console.warn("[expenseService] expense_classifications id-link columns missing â€” treating as no persisted classifications.");
    return [];
  }

  return [...mergedRows.values()];
}

export const expenseService = {
  ...baseExpenseService,
  isApprovedLeaseRule,

  async resolveExpenseLeaseLink(expenseLike = {}, leases = null) {
    if (expenseLike?.skip_lease_resolution === true) {
      const expense = { ...expenseLike };
      delete expense.skip_lease_resolution;
      return {
        lease: null,
        candidates: [],
        isAmbiguous: false,
        expense,
      };
    }
    const availableLeases = Array.isArray(leases) ? leases : await listWorkflowEntityRows("Lease");
    const directLease = expenseLike?.lease_id
      ? availableLeases.find((lease) => lease.id === expenseLike.lease_id) || null
      : null;

    if (directLease) {
      return {
        lease: directLease,
        candidates: [directLease],
        isAmbiguous: false,
        expense: applyLeaseLinkToExpense(expenseLike, directLease),
      };
    }

    const candidates = findMatchingLeasesForExpense(expenseLike, availableLeases);
    const matchedLease = candidates.length === 1 ? candidates[0] : null;
    return {
      lease: matchedLease,
      candidates,
      isAmbiguous: candidates.length > 1,
      expense: matchedLease ? applyLeaseLinkToExpense(expenseLike, matchedLease) : { ...expenseLike },
    };
  },

  async create(data) {
    const { expense } = await this.resolveExpenseLeaseLink(data);
    return baseExpenseService.create(expense);
  },

  // Server-owned, audited replacement for the manual/single expense-create
  // path (Phase 6D-7: create_expense_workflow RPC / create-expense-workflow
  // edge function). The lease-link derivation (resolveExpenseLeaseLink)
  // stays unchanged, client-side; only the mechanical insert + audit moves
  // server-side. Bulk import (BulkImport.jsx) still calls create() above,
  // unchanged -- not migrated in this pass.
  async createExpenseWorkflow(data) {
    const { expense } = await this.resolveExpenseLeaseLink(data);
    const {
      date, amount, category, vendor, vendor_id, description, classification,
      portfolio_id, property_id, building_id, unit_id, attachment_url,
      lease_id, tenant_id, source, fiscal_year, approval_status, review_status,
      service_period_start, service_period_end,
    } = expense;
    return invokeEdgeFunction("create-expense-workflow", {
      expense: {
        date, amount, category, vendor, vendor_id, description, classification,
        portfolio_id, property_id, building_id, unit_id, attachment_url,
        lease_id, tenant_id, source, fiscal_year, approval_status, review_status,
        service_period_start, service_period_end,
      },
    });
  },

  async update(id, data) {
    const current = await baseExpenseService.get(id);
    const merged = { ...current, ...data, id };
    const { expense } = await this.resolveExpenseLeaseLink(merged);
    const payload = { ...expense };
    delete payload.id;
    return baseExpenseService.update(id, payload);
  },

  // Server-owned, audited replacement for AddExpense.jsx's "Edit Expense"
  // save path (Phase 6X-3: update_expense_details RPC /
  // update-expense-details edge function). The current-row fetch + merge +
  // lease-link re-derivation (resolveExpenseLeaseLink) stay entirely
  // client-side, unchanged -- matching createExpenseWorkflow's Phase 6D-7
  // precedent -- only the mechanical persist + audit moves server-side.
  // update() above is untouched (its only caller now uses this instead;
  // left in place rather than removed since it's the generic entity-service
  // contract other code may still rely on).
  async updateExpenseWorkflow(id, data) {
    const current = await baseExpenseService.get(id);
    const merged = { ...current, ...data, id };
    const { expense } = await this.resolveExpenseLeaseLink(merged);
    const {
      date, amount, category, vendor, vendor_id, description, classification,
      portfolio_id, property_id, building_id, unit_id, attachment_url,
      lease_id, tenant_id, source, fiscal_year,
      service_period_start, service_period_end,
    } = expense;
    const result = await invokeEdgeFunction("update-expense-details", {
      expense_id: id,
      expense: {
        date, amount, category, vendor, vendor_id, description, classification,
        portfolio_id, property_id, building_id, unit_id, attachment_url,
        lease_id, tenant_id, source, fiscal_year,
        service_period_start, service_period_end,
      },
    });
    clearCache();
    return result?.expense ?? null;
  },

  // Server-owned, audited, transactional replacement for Expenses.jsx's
  // single-delete and bulk-delete actions (Phase 6X-4: delete_expenses_workflow
  // RPC / delete-expenses edge function). Accepts one or many ids uniformly --
  // callers pass a single-element array for the single-delete dialog and the
  // full selection array for bulk delete -- so both UI paths share one
  // atomic, all-or-nothing server call instead of today's per-id Promise.all.
  async deleteExpensesWorkflow(expenseIds) {
    const ids = Array.isArray(expenseIds) ? expenseIds : [expenseIds];
    if (ids.length === 0) {
      throw new Error("At least one expense id is required");
    }
    return invokeEdgeFunction("delete-expenses", { expense_ids: ids });
  },

  // Server-owned, audited, transactional (all-or-nothing) replacement for
  // BulkImport.jsx's CSV/Excel import loop (Phase 6X-5:
  // bulk_create_expenses_workflow RPC / bulk-create-expenses edge
  // function). Per-row lease-link derivation (resolveExpenseLeaseLink)
  // stays entirely client-side, unchanged -- the leases list is fetched
  // once up front and reused across all rows instead of once per row, to
  // avoid N redundant queries for an N-row import. rows is the same
  // shape BulkImport already builds per CSV row today.
  async bulkCreateExpensesWorkflow(rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error("At least one expense row is required");
    }
    const leases = await listWorkflowEntityRows("Lease");
    const expenses = [];
    for (const row of rows) {
      const { expense } = await this.resolveExpenseLeaseLink(row, leases);
      const {
        date, amount, category, vendor, description, classification, source,
        gl_code, invoice_number, portfolio_id, property_id, building_id, unit_id,
        lease_id, tenant_id, tenant_name, fiscal_year,
      } = expense;
      expenses.push({
        date, amount, category, vendor, description, classification, source,
        gl_code, invoice_number, portfolio_id, property_id, building_id, unit_id,
        lease_id, tenant_id, tenant_name, fiscal_year,
      });
    }
    return invokeEdgeFunction("bulk-create-expenses", { expenses });
  },

  async listExpenseClassificationsForExpenses(expenseIds = []) {
    if (!expenseIds.length) return [];
    try {
      return await selectExpenseClassificationsForExpenseIds(expenseIds, [
        "id",
        "org_id",
        "classification_key",
        "expense_id",
        "actual_expense_id",
        "lease_expense_rule_id",
        "property_id",
        "building_id",
        "unit_id",
        "lease_id",
        "tenant_id",
        "category",
        "subcategory",
        "amount",
        "service_period_start",
        "service_period_end",
        "cam_eligible",
        "recovery_method",
        "recovery_reason",
        "rule_source",
        "evidence_text",
        "notes",
        "confidence_score",
        "recoverability_result",
        "recovery_status",
        "exception_type",
        "classification_status",
        "row_type",
        "recoverable_amount",
        "non_recoverable_amount",
        "conditional_amount",
        "excluded_amount",
        "sent_to_cam",
        "sent_to_cam_at",
        "sent_to_cam_by",
        "cam_status",
        "cam_source",
        "cam_input_type",
        "manual_cam_reviewed",
        "manual_cam_reason",
        "manual_cam_reviewed_by",
        "manual_cam_reviewed_at",
        "next_step",
        "classified_at",
        "finalized_at",
        "reviewed_at",
        "updated_at",
        "approved_status"
      ]);
    } catch (error) {
      console.error("[TASK 1] Exact Supabase error from expense_classifications (listExpenseClassificationsForExpenses):", {
        code: error?.code,
        message: error?.message,
        details: error?.details,
        filters: `expenseIds: ${expenseIds.join(",")}`,
        errorObj: error
      });
      if (isMissingExpenseRuleTable(error)) {
        console.warn("[expenseService] listExpenseClassificationsForExpenses: table missing");
        return [];
      }
      throw error;
    }
  },

  async listExpenseClassificationsForScope(scope = {}) {
    try {
      const orgId = await getCurrentOrgId();
      const rows = await selectExpenseClassifications({
        columns: [
          "id",
          "org_id",
          "expense_id",
          "actual_expense_id",
          "lease_expense_rule_id",
          "property_id",
          "building_id",
          "unit_id",
          "lease_id",
          "tenant_id",
          "category",
          "subcategory",
          "amount",
          "service_period_start",
          "service_period_end",
          "cam_eligible",
          "recovery_method",
          "recovery_reason",
          "rule_source",
          "evidence_text",
          "notes",
          "confidence_score",
          "recoverability_result",
          "recovery_status",
          "exception_type",
          "classification_status",
          "row_type",
          "classification_key",
          "recoverable_amount",
          "non_recoverable_amount",
          "conditional_amount",
          "excluded_amount",
          "sent_to_cam",
          "sent_to_cam_at",
          "sent_to_cam_by",
          "cam_status",
          "cam_source",
          "cam_input_type",
          "manual_cam_reviewed",
          "manual_cam_reason",
          "manual_cam_reviewed_by",
          "manual_cam_reviewed_at",
          "next_step",
          "classified_at",
          "finalized_at",
          "reviewed_at",
          "updated_at",
          "approved_status"
        ],
        apply: (query) => {
          let scopedQuery = query;
          if (orgId && orgId !== "__none__") {
            scopedQuery = scopedQuery.eq("org_id", orgId);
          }
          if (scope.property_id && scope.property_id !== "all") {
            scopedQuery = scopedQuery.eq("property_id", scope.property_id);
          }
          if (scope.building_id && scope.building_id !== "all") {
            scopedQuery = scopedQuery.eq("building_id", scope.building_id);
          }
          if (scope.unit_id && scope.unit_id !== "all") {
            scopedQuery = scopedQuery.eq("unit_id", scope.unit_id);
          }
          if (scope.lease_id && scope.lease_id !== "all") {
            scopedQuery = scopedQuery.eq("lease_id", scope.lease_id);
          }
          if (scope.tenant_id && scope.tenant_id !== "all") {
            scopedQuery = scopedQuery.eq("tenant_id", scope.tenant_id);
          }
          return scopedQuery.limit(5000);
        },
      });

      return rows
        .filter((row) => classificationMatchesScope(row, scope))
        .sort((left, right) => {
          const leftTime = Date.parse(
            left?.classified_at || left?.reviewed_at || left?.finalized_at || left?.updated_at || ""
          );
          const rightTime = Date.parse(
            right?.classified_at || right?.reviewed_at || right?.finalized_at || right?.updated_at || ""
          );
          if (!Number.isFinite(leftTime) && !Number.isFinite(rightTime)) return 0;
          if (!Number.isFinite(leftTime)) return 1;
          if (!Number.isFinite(rightTime)) return -1;
          return rightTime - leftTime;
        });
    } catch (error) {
      console.error("[TASK 1] Exact Supabase error from expense_classifications (listExpenseClassificationsForScope):", {
        code: error?.code,
        message: error?.message,
        details: error?.details,
        scope: scope,
        errorObj: error
      });
      if (isMissingExpenseRuleTable(error)) {
        console.warn("[expenseService] listExpenseClassificationsForScope: table missing");
        return [];
      }
      throw error;
    }
  },

  async listExpenseClassificationsForLease({ leaseId, propertyId = null, limit = 1000 } = {}) {
    if (!leaseId) return [];
    try {
      return await selectExpenseClassifications({
        columns: [
          "id",
          "org_id",
          "expense_id",
          "actual_expense_id",
          "lease_expense_rule_id",
          "property_id",
          "building_id",
          "unit_id",
          "lease_id",
          "tenant_id",
          "category",
          "subcategory",
          "amount",
          "service_period_start",
          "service_period_end",
          "cam_eligible",
          "recovery_method",
          "recovery_reason",
          "rule_source",
          "evidence_text",
          "notes",
          "confidence_score",
          "recoverability_result",
          "recovery_status",
          "exception_type",
          "classification_status",
          "row_type",
          "classification_key",
          "recoverable_amount",
          "non_recoverable_amount",
          "conditional_amount",
          "excluded_amount",
          "sent_to_cam",
          "sent_to_cam_at",
          "sent_to_cam_by",
          "cam_status",
          "cam_source",
          "cam_input_type",
          "manual_cam_reviewed",
          "manual_cam_reason",
          "manual_cam_reviewed_by",
          "manual_cam_reviewed_at",
          "next_step",
          "classified_at",
          "finalized_at",
          "reviewed_at",
          "updated_at",
          "approved_status"
        ],
        apply: (query) => {
          const orFilter = [`lease_id.eq.${leaseId}`];
          if (propertyId) orFilter.push(`and(lease_id.is.null,property_id.eq.${propertyId})`);
          return query
            .or(orFilter.join(","))
            .order("classified_at", { ascending: false })
            .limit(limit);
        },
      });
    } catch (error) {
      console.error("[TASK 1] Exact Supabase error from expense_classifications (listExpenseClassificationsForLease):", {
        code: error?.code,
        message: error?.message,
        details: error?.details,
        filters: `leaseId: ${leaseId}, propertyId: ${propertyId}`,
        errorObj: error
      });
      if (isMissingExpenseRuleTable(error)) {
        console.warn("[expenseService] listExpenseClassificationsForLease: table missing");
        return [];
      }
      throw error;
    }
  },

  async reviewExpense(expenseOrId, { recoveryStatus, approvedStatus, ruleSource = "manual", reason = null } = {}) {
    const expense =
      expenseOrId && typeof expenseOrId === "object"
        ? expenseOrId
        : await baseExpenseService.get(expenseOrId);

    if (!expense?.id) {
      throw new Error("Expense not found");
    }

    const [existingClassification, orgIdFallback, authResult] = await Promise.all([
      fetchExistingExpenseClassifications([expense.id]).then((rows) => rows[0] || null),
      getCurrentOrgId(),
      supabase?.auth?.getUser?.() || Promise.resolve(null),
    ]);

    const now = new Date().toISOString();
    const userId = authResult?.data?.user?.id || null;
    const effectiveRecoveryStatus =
      recoveryStatus ||
      existingClassification?.recoverability_result ||
      existingClassification?.recovery_status ||
      expense.recovery_status ||
      expense.classification ||
      "needs_review";
    const effectiveApprovedStatus =
      approvedStatus ||
      existingClassification?.approved_status ||
      expense.approved_status ||
      (effectiveRecoveryStatus === "needs_review" || effectiveRecoveryStatus === "conditional"
        ? "needs_review"
        : "approved");
    const effectiveRuleSource =
      ruleSource ||
      existingClassification?.rule_source ||
      expense.rule_source ||
      "manual";
    const effectiveReason =
      reason ||
      existingClassification?.recovery_reason ||
      existingClassification?.notes ||
      expense.recovery_reason ||
      "Manual review override";
    const effectiveReviewStatus =
      effectiveApprovedStatus === "approved"
        ? "approved"
        : effectiveRecoveryStatus === "needs_review"
          ? "needs_review"
          : "draft";
    const classification =
      effectiveRecoveryStatus === "excluded" ? "non_recoverable" : effectiveRecoveryStatus;
    const linkedExpenseRuleId =
      existingClassification?.lease_expense_rule_id ||
      existingClassification?.linked_expense_rule_id ||
      existingClassification?.recovery_rule_id ||
      expense.linked_expense_rule_id ||
      expense.recovery_rule_id ||
      null;
    const classificationKey =
      existingClassification?.classification_key ||
      buildClassificationKey({
        orgId: expense.org_id || existingClassification?.org_id || orgIdFallback,
        expenseId: expense.id,
        leaseExpenseRuleId: linkedExpenseRuleId,
      });
    const amount = Number.isFinite(Number(expense.amount)) ? Number(expense.amount) : existingClassification?.amount ?? 0;
    const amountBuckets = buildAmountBuckets(amount, effectiveRecoveryStatus);
    const plainReason = buildPlainEnglishReason({
      expense,
      rule: null,
      recoverabilityResult: effectiveRecoveryStatus,
      fallbackReason: effectiveReason,
    });

    // Phase 6X-1: only `classification`/`recovery_status` are ever actually
    // persisted to `expenses` by this workflow (confirmed: the pre-existing
    // persistExpenseWorkflowPatch this replaces silently discarded every
    // other field of a similarly-shaped patch object here) — passed through
    // as expensePatch below so the same RPC call that upserts the
    // classification row also updates expenses in the same transaction.
    const updatedExpense = { ...expense, classification, recovery_status: effectiveRecoveryStatus, updated_at: now };

    await upsertExpenseClassification({
      id: existingClassification?.id,
      org_id: expense.org_id || existingClassification?.org_id || orgIdFallback,
      expense_id: expense.id,
      actual_expense_id: expense.id,
      classification_key: classificationKey,
      property_id: expense.property_id || existingClassification?.property_id || null,
      building_id: expense.building_id || existingClassification?.building_id || null,
      unit_id: expense.unit_id || existingClassification?.unit_id || null,
      lease_id: expense.lease_id || existingClassification?.lease_id || null,
      tenant_id: expense.tenant_id || existingClassification?.tenant_id || null,
      rule_set_id: existingClassification?.rule_set_id || null,
      recovery_rule_id:
        existingClassification?.recovery_rule_id ||
        expense.recovery_rule_id ||
        expense.linked_expense_rule_id ||
        null,
      linked_expense_rule_id:
        linkedExpenseRuleId,
      lease_expense_rule_id: linkedExpenseRuleId,
      category: expense.category || null,
      subcategory: expense.expense_subcategory || expense.subcategory || null,
      amount,
      service_period_start:
        expense.service_period_start ||
        expense.billing_period_start ||
        expense.expense_date ||
        expense.date ||
        null,
      service_period_end:
        expense.service_period_end ||
        expense.billing_period_end ||
        expense.expense_date ||
        expense.date ||
        null,
      recovery_status: effectiveRecoveryStatus,
      recoverability_result: effectiveRecoveryStatus,
      cam_eligible:
        existingClassification?.cam_eligible ||
        expense.cam_eligible ||
        (effectiveRecoveryStatus === "recoverable"
          ? "yes"
          : effectiveRecoveryStatus === "conditional"
            ? "conditional"
            : "no"),
      recovery_method: existingClassification?.recovery_method || expense.recovery_method || null,
      recovery_reason: plainReason,
      cam_pool_id: existingClassification?.cam_pool_id || expense.cam_pool_id || null,
      allocation_method:
        expense.allocation_method ||
        expense.allocation_type ||
        existingClassification?.allocation_method ||
        "pro_rata",
      allocation_basis:
        existingClassification?.allocation_basis ||
        expense.allocation_method ||
        expense.allocation_type ||
        existingClassification?.allocation_method ||
        "pro_rata",
      cap_applied: Boolean(existingClassification?.cap_applied),
      exclusion_applied: ["excluded", "non_recoverable"].includes(effectiveRecoveryStatus),
      condition_applied: effectiveRecoveryStatus === "conditional",
      condition_reason: effectiveRecoveryStatus === "conditional" ? plainReason : null,
      condition_resolved: effectiveRecoveryStatus !== "conditional",
      condition_result: effectiveRecoveryStatus === "conditional" ? "manual_review" : null,
      rule_source: effectiveRuleSource,
      confidence_score: existingClassification?.confidence_score ?? expense.confidence_score ?? 1,
      evidence_text: existingClassification?.evidence_text || expense.evidence_text || plainReason,
      evidence_page_number: existingClassification?.evidence_page_number || expense.evidence_page_number || null,
      approved_status: effectiveApprovedStatus,
      classification_status:
        effectiveApprovedStatus === "approved"
          ? (effectiveRecoveryStatus === "recoverable"
            ? "finalized"
            : effectiveRecoveryStatus === "conditional"
              ? "conditional"
              : "excluded")
          : effectiveRecoveryStatus === "needs_review"
            ? "exception"
            : effectiveRecoveryStatus === "conditional"
              ? "conditional"
              : ["excluded", "non_recoverable"].includes(effectiveRecoveryStatus)
                ? "excluded"
                : "matched",
      exception_type: (effectiveRecoveryStatus === "needs_review" || effectiveRecoveryStatus === "conditional") ? "manual_review" : null,
      finalized_at:
        effectiveApprovedStatus === "approved" && ["recoverable", "non_recoverable", "excluded"].includes(effectiveRecoveryStatus)
          ? (existingClassification?.finalized_at || now)
          : null,
      ...amountBuckets,
      sent_to_cam: existingClassification?.sent_to_cam || false,
      cam_status: existingClassification?.cam_status || null,
      next_step: buildClassificationNextStep({
        classificationStatus:
          effectiveApprovedStatus === "approved"
            ? (effectiveRecoveryStatus === "recoverable"
              ? "finalized"
              : effectiveRecoveryStatus === "conditional"
                ? "conditional"
                : "excluded")
            : effectiveRecoveryStatus === "needs_review"
              ? "exception"
              : effectiveRecoveryStatus === "conditional"
                ? "conditional"
                : ["excluded", "non_recoverable"].includes(effectiveRecoveryStatus)
                  ? "excluded"
                  : "matched",
        recoverabilityResult: effectiveRecoveryStatus,
        sentToCam: existingClassification?.sent_to_cam || false,
        camEligible:
          existingClassification?.cam_eligible ||
          expense.cam_eligible ||
          (effectiveRecoveryStatus === "recoverable" ? "yes" : effectiveRecoveryStatus === "conditional" ? "conditional" : "no"),
      }),
      reviewed_by: userId || existingClassification?.reviewed_by || null,
      reviewed_at: now,
      approved_at: effectiveApprovedStatus === "approved" ? (existingClassification?.approved_at || now) : null,
      approved_by: effectiveApprovedStatus === "approved" ? (userId || existingClassification?.approved_by || null) : null,
      classified_at: existingClassification?.classified_at || now,
      classified_by: userId || existingClassification?.classified_by || null,
      notes: plainReason || existingClassification?.notes || null,
    }, {
      expensePatch: { classification, recovery_status: effectiveRecoveryStatus },
    });

    return {
      ...updatedExpense,
      recovery_status: effectiveRecoveryStatus,
      recoverability_result: effectiveRecoveryStatus,
      approved_status: effectiveApprovedStatus,
      review_status: effectiveReviewStatus,
      rule_source: effectiveRuleSource,
      recovery_reason: plainReason,
      classification,
    };
  },

  matchActualExpenseToLeaseRule(actualExpense, { leases = [], rulesByLeaseId = new Map() } = {}) {
    // Defensive eligibility gate. Loaders SHOULD filter both sides before
    // reaching this matcher, but the matcher is also called by other code
    // paths (runExpenseClassification, manual review flows). Short-circuiting
    // here guarantees an ineligible row never produces a matched_classification
    // even if a caller skipped the loader filter.
    if (!isActualClassificationEligible(actualExpense, { scopeMatch: true })) {
      return {
        linked_expense_rule_id: null,
        recoverability_result: "needs_review",
        cam_eligible: "needs_review",
        recovery_method: null,
        reason: `Actual expense is not classification-eligible (${getActualClassificationExclusionReason(actualExpense, { scopeMatch: true })}).`,
        lease: null,
        rule: null,
        score: 0,
      };
    }

    const expenseLeaseId = actualExpense?.lease_id || null;
    const candidateLeases = expenseLeaseId
      ? (leases || []).filter((lease) => lease?.id === expenseLeaseId)
      : (leases || []).filter((lease) => {
        if (actualExpense?.property_id && lease?.property_id !== actualExpense.property_id) return false;
        if (actualExpense?.building_id && lease?.building_id && lease.building_id !== actualExpense.building_id) return false;
        if (actualExpense?.unit_id && lease?.unit_id && lease.unit_id !== actualExpense.unit_id) return false;
        return servicePeriodOverlaps(actualExpense, lease);
      });

    let matchedRule = null;
    let matchedLease = null;
    let bestScore = 0;

    for (const lease of candidateLeases) {
      const candidateRules = rulesByLeaseId.get(lease.id) || [];
      for (const rule of candidateRules) {
        // Skip ineligible rules as defensive double-check. Loaders already
        // filter; this guards against rulesByLeaseId being built from a
        // different source than loadApprovedLeaseExpenseRules.
        if (!isRuleClassificationEligible(rule, { scopeMatch: true })) continue;
        const scopeScore = scoreScopeMatch(actualExpense, rule);
        const categoryScore = scoreRuleMatch(actualExpense, rule);
        const periodScore = servicePeriodOverlaps(actualExpense, lease) ? 40 : -1000;
        const score = scopeScore + categoryScore + periodScore;
        if (score > bestScore) {
          bestScore = score;
          matchedRule = rule;
          matchedLease = lease;
        }
      }
    }

    if (!matchedRule || bestScore < 120) {
      return {
        linked_expense_rule_id: null,
        recoverability_result: "needs_review",
        // Unmatched actuals are Needs Review. They are NOT conditional (no rule
        // to be conditional about) and NOT excluded (no explicit lease signal).
        cam_eligible: "needs_review",
        recovery_method: null,
        reason: "No approved lease expense rule matched this actual expense with enough confidence.",
        lease: matchedLease,
        rule: null,
        score: bestScore,
      };
    }

    return {
      linked_expense_rule_id: matchedRule.id,
      recoverability_result: recoverabilityResultFromRule(matchedRule),
      cam_eligible: leaseExpenseRuleService.getCamEligibleDecision(matchedRule),
      recovery_method: matchedRule.recovery_method || null,
      reason: buildMatchReason(actualExpense, matchedRule, bestScore),
      lease: matchedLease,
      rule: matchedRule,
      score: bestScore,
    };
  },

  // Phase 6X-7A: server-owned, audited replacement for this cleanup's
  // delete step (delete_expenses_workflow, Phase 6X-4) -- previously a
  // per-row baseExpenseService.delete() loop (unaudited beyond a
  // fire-and-forget logAudit(), non-atomic). The read/filter logic that
  // decides which rows are legacy lease_import junk for the lease(s) being
  // approved is unchanged, client-side. This was the last remaining direct
  // browser .delete() path on expenses anywhere in src/.
  async syncLeaseDerivedExpenses({ leases = [], existingExpenses = [], properties: _properties = [] } = {}) {
    const leaseIds = new Set((leases || []).map((lease) => lease?.id).filter(Boolean));
    if (leaseIds.size === 0) return { created: 0, updated: 0, deleted: 0 };

    const allExistingExpenses =
      Array.isArray(existingExpenses) && existingExpenses.length > 0
        ? existingExpenses
        : await baseExpenseService.list();

    const legacyLeaseImportExpenses = (allExistingExpenses || []).filter((expense) =>
      normalizeSourceType(expense) === "lease_import" &&
      leaseIds.has(expense.lease_id)
    );

    if (legacyLeaseImportExpenses.length === 0) {
      return { created: 0, updated: 0, deleted: 0 };
    }

    const matchingIds = legacyLeaseImportExpenses.map((expense) => expense.id);
    const result = await this.deleteExpensesWorkflow(matchingIds);
    return { created: 0, updated: 0, deleted: result?.deleted_count ?? matchingIds.length };
  },

  async classifyExpenses({ expenses = [], leases = [] } = {}) {
    const allExpenses =
      Array.isArray(expenses) && expenses.length > 0
        ? expenses
        : await baseExpenseService.list();

    const actualExpenses = allExpenses.filter((expense) => normalizeSourceType(expense) !== "lease_import");
    const approvedActualExpenses = actualExpenses.filter((expense) => isApprovedExpenseRecord(expense));

    if (!approvedActualExpenses.length) {
      return { updated: 0, needsReview: 0, classified: 0 };
    }

    const allLeases =
      Array.isArray(leases) && leases.length > 0
        ? leases
        : await baseLeaseService.list();

    const leaseIds = [...new Set(allLeases.map((lease) => lease.id).filter(Boolean))];
    const { ruleSets, rules, categories } = await fetchApprovedRuleArtifacts(leaseIds);
    const { rulesByLeaseId } = buildApprovedRuleLookups(rules, categories);
    const leaseById = buildLeaseLookup(allLeases);
    const orgIdFallback = await getCurrentOrgId();
    const existingClassificationsByExpenseId = new Map(
      (await fetchExistingExpenseClassifications(approvedActualExpenses.map((expense) => expense.id)))
        .map((classification) => [classification.expense_id, classification])
    );

    let updated = 0;
    let needsReview = 0;
    let classified = 0;

    for (const expense of approvedActualExpenses) {
      const existingClassification = existingClassificationsByExpenseId.get(expense.id) || null;
      if (normalizeText(existingClassification?.classification_status) === "finalized" && !existingClassification?.reopened_at) {
        classified += 1;
        continue;
      }
      const preserveManualReview =
        normalizeText(existingClassification?.rule_source) === "manual" ||
        (
          normalizeText(expense?.rule_source) === "manual" &&
          normalizeText(existingClassification?.approved_status || expense?.approved_status) === "approved"
        );
      const match = this.matchActualExpenseToLeaseRule(expense, { leases: allLeases, rulesByLeaseId });
      const matchedRule = match.rule;
      const matchedLease = match.lease || (expense.lease_id ? leaseById.get(expense.lease_id) : null);
      const matchedRuleSet = matchedRule ? ruleSets.find((ruleSet) => ruleSet.id === matchedRule.rule_set_id) || null : null;
      let recoveryStatus = match.recoverability_result === "non_recoverable" ? "non_recoverable" : match.recoverability_result;
      let isConditional = recoveryStatus === "conditional" || (matchedRule ? conditionApplied(matchedRule) : false);
      const confidenceScore = matchedRule
        ? asNumberOrNull(matchedRule.confidence_score ?? matchedRule.confidence) ?? Math.min(match.score / 100, 1)
        : (existingClassification?.confidence_score ?? 0);
      let approvedStatus =
        matchedRule &&
          !isConditional &&
          recoveryStatus !== "needs_review"
          ? "approved"
          : "needs_review";
      let linkedExpenseRuleId = match.linked_expense_rule_id;
      let camEligible = matchedRule
        ? match.cam_eligible
        : "needs_review";
      let recoveryMethod = match.recovery_method || null;
      let recoveryReason = match.reason;
      let ruleSource = matchedRule ? "lease" : (expense.rule_source || "default");
      let classificationKey = buildClassificationKey({
        orgId: expense.org_id || matchedLease?.org_id || orgIdFallback,
        expenseId: expense.id,
        leaseExpenseRuleId: linkedExpenseRuleId,
      });

      if (preserveManualReview) {
        recoveryStatus =
          existingClassification?.recoverability_result ||
          existingClassification?.recovery_status ||
          expense.recovery_status ||
          expense.classification ||
          "needs_review";
        isConditional = recoveryStatus === "conditional";
        approvedStatus =
          existingClassification?.approved_status ||
          expense.approved_status ||
          approvedStatus;
        linkedExpenseRuleId =
          existingClassification?.linked_expense_rule_id ||
          existingClassification?.recovery_rule_id ||
          expense.linked_expense_rule_id ||
          expense.recovery_rule_id ||
          linkedExpenseRuleId;
        camEligible =
          existingClassification?.cam_eligible ||
          expense.cam_eligible ||
          (recoveryStatus === "recoverable"
            ? "yes"
            : recoveryStatus === "conditional"
              ? "conditional"
              : "no");
        recoveryMethod =
          existingClassification?.recovery_method ||
          expense.recovery_method ||
          recoveryMethod;
        recoveryReason =
          existingClassification?.recovery_reason ||
          existingClassification?.notes ||
          expense.recovery_reason ||
          "Manual review override preserved.";
        ruleSource =
          existingClassification?.rule_source ||
          expense.rule_source ||
          "manual";
        classificationKey =
          existingClassification?.classification_key ||
          buildClassificationKey({
            orgId: expense.org_id || matchedLease?.org_id || orgIdFallback,
            expenseId: expense.id,
            leaseExpenseRuleId: linkedExpenseRuleId,
          });
      }

      const plainReason = buildPlainEnglishReason({
        expense,
        rule: matchedRule,
        recoverabilityResult: recoveryStatus,
        fallbackReason: recoveryReason,
      });
      const amount = Number.isFinite(Number(expense.amount)) ? Number(expense.amount) : 0;
      const amountBuckets = buildAmountBuckets(amount, recoveryStatus);
      const explicitExclusion = hasExplicitCamExclusion({
        classification: existingClassification || {},
        expense,
        rule: matchedRule,
      });
      const isAutomaticCamReady =
        Boolean(matchedRule) &&
        recoveryStatus === "recoverable" &&
        camEligible === "yes" &&
        matchedRule?.published_to_cam === true &&
        amount > 0 &&
        !explicitExclusion;
      const nextCamStatus = isAutomaticCamReady
        ? "cam_ready"
        : explicitExclusion
          ? "excluded"
          : "needs_review";
      const nextCamSource = isAutomaticCamReady ? "lease_rule" : "none";

      const updatePayload = {
        classification: recoveryStatus === "excluded" ? "non_recoverable" : recoveryStatus,
        recovery_status: recoveryStatus,
        recoverability_result: recoveryStatus,
        cam_eligible: isAutomaticCamReady ? "yes" : (explicitExclusion ? "no" : camEligible),
        cam_status: nextCamStatus,
        cam_source: nextCamSource,
        cam_input_type: "actual_expense",
        // Do NOT write approved_status / review_status here.
        // Classification only derives CAM treatment; expense approval is owned
        // exclusively by the Expense Review workflow.
        rule_source: ruleSource,
        recovery_reason: plainReason,
        classification_updated_at: new Date().toISOString(),
        lease_id: expense.lease_id || matchedLease?.id || null,
        tenant_id: expense.tenant_id || matchedLease?.tenant_id || null,
        property_id: expense.property_id || matchedLease?.property_id || null,
        building_id: expense.building_id || matchedLease?.building_id || null,
        unit_id: expense.unit_id || matchedLease?.unit_id || null,
      };

      updated += 1;

      if (approvedStatus === "needs_review") {
        needsReview += 1;
      } else {
        classified += 1;
      }

      // Spec lifecycle status + exception type — drives Expense Review's
      // exception bucket and Expense Projection's finalized-only filter.
      // classification_status states:
      //   unmatched     no rule matched
      //   exception     low confidence / rule conflict / missing fields
      //   conditional   matched but recovery depends on cap/threshold review
      //   matched       matched cleanly, awaiting human finalize
      //   finalized     human approved
      //   excluded      rule says non-recoverable
      let classificationStatus;
      let exceptionType = null;
      if (!matchedRule) {
        classificationStatus = "unmatched";
        exceptionType = "unmatched";
      } else if (recoveryStatus === "excluded" || recoveryStatus === "non_recoverable") {
        classificationStatus = "excluded";
      } else if (recoveryStatus === "needs_review") {
        classificationStatus = "exception";
        exceptionType = confidenceScore < 0.5 ? "low_confidence" : "missing_decision";
      } else if (isConditional) {
        classificationStatus = "conditional";
        exceptionType = "manual_review";
      } else {
        classificationStatus = "matched";
      }
      // Auto-promote to finalized has been REMOVED per business rules.
      // Do not auto-approve anything extracted by AI. The classification
      // should land in matched (for human to finalize).
      // Only preserve finalized state if it's a manual override.
      if (preserveManualReview && existingClassification?.classification_status === "finalized") {
        classificationStatus = "finalized";
      }

      await upsertExpenseClassification({
        org_id: expense.org_id || matchedLease?.org_id || orgIdFallback,
        expense_id: expense.id,
        actual_expense_id: expense.id,                       // spec alias
        classification_key: existingClassification?.classification_key || classificationKey,
        property_id: expense.property_id || matchedLease?.property_id || null,
        building_id: expense.building_id || matchedLease?.building_id || null,
        unit_id: expense.unit_id || matchedLease?.unit_id || null,
        lease_id: expense.lease_id || matchedLease?.id || null,
        tenant_id: expense.tenant_id || matchedLease?.tenant_id || null,
        rule_set_id: matchedRuleSet?.id || null,
        recovery_rule_id: linkedExpenseRuleId,
        linked_expense_rule_id: linkedExpenseRuleId,
        lease_expense_rule_id: linkedExpenseRuleId,          // spec alias
        // Denormalized snapshot — Expense Review / Projection can read
        // these without joining expenses + lease_expense_rules.
        category: expense.category || matchedRule?.expense_category || null,
        subcategory: expense.subcategory || matchedRule?.expense_subcategory || null,
        amount,
        service_period_start: expense.service_period_start || expense.date || null,
        service_period_end: expense.service_period_end || expense.date || null,
        recovery_status: recoveryStatus,
        recoverability_result: recoveryStatus,
        cam_eligible: isAutomaticCamReady ? "yes" : (explicitExclusion ? "no" : camEligible),
        cam_status: nextCamStatus,
        cam_source: nextCamSource,
        cam_input_type: "actual_expense",
        manual_cam_reviewed: Boolean(existingClassification?.manual_cam_reviewed),
        recovery_method: recoveryMethod,
        recovery_reason: plainReason,
        cam_pool_id: updatePayload.cam_pool_id,
        allocation_method: expense.allocation_method || expense.allocation_type || existingClassification?.allocation_method || "pro_rata",
        allocation_basis: expense.allocation_method || expense.allocation_type || existingClassification?.allocation_basis || existingClassification?.allocation_method || "pro_rata",
        cap_applied: Boolean(matchedRule?.is_subject_to_cap),
        exclusion_applied: Boolean(matchedRule?.is_excluded),
        condition_applied: isConditional,
        condition_reason: isConditional ? matchedRule?.notes || matchedRule?.source || plainReason || "Conditional lease rule requires review" : null,
        condition_resolved: !isConditional,
        condition_result: isConditional ? "manual_review" : null,
        rule_source: ruleSource,
        confidence_score: confidenceScore,
        evidence_text: matchedRule?.source || plainReason,
        evidence_page_number: matchedRule?.clauses?.[0]?.page_number ?? null,
        approved_status: approvedStatus,
        classification_status: classificationStatus,
        exception_type: exceptionType,
        finalized_at: classificationStatus === "finalized" ? new Date().toISOString() : null,
        reviewed_by: existingClassification?.reviewed_by || null,
        ...amountBuckets,
        sent_to_cam: isAutomaticCamReady || existingClassification?.sent_to_cam || false,
        sent_to_cam_at: existingClassification?.sent_to_cam_at || null,
        sent_to_cam_by: existingClassification?.sent_to_cam_by || null,
        manual_cam_reason: existingClassification?.manual_cam_reason || null,
        next_step: buildClassificationNextStep({
          classificationStatus,
          recoverabilityResult: recoveryStatus,
          sentToCam: isAutomaticCamReady || existingClassification?.sent_to_cam || false,
          camEligible: isAutomaticCamReady ? "yes" : camEligible,
          camStatus: nextCamStatus,
        }),
        notes: matchedRule?.notes || plainReason || null,
        classified_at: new Date().toISOString(),
      }, {
        expensePatch: { classification: updatePayload.classification, recovery_status: recoveryStatus },
      });
    }

    return { updated, needsReview, classified };
  },

  // Phase 6X-2: server-owned, audited replacement for the direct
  // baseExpenseService.update({amount}) write this used to perform. The
  // subsequent classifyExpenses() re-run (re-deriving classification/CAM
  // fields off the new amount) is unchanged, client-side, and already
  // routes its own expenses/expense_classifications writes through
  // persist_expense_classification (Phase 6X-1).
  async updateExpenseAmount(expenseId, amount, { reason = "Manual amount correction from Expense Classification" } = {}) {
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount < 0) {
      throw new Error("Enter a valid amount");
    }

    const result = await invokeEdgeFunction("update-expense-amount", {
      expense_id: expenseId,
      amount: numericAmount,
    });
    const updatedExpense = result?.expense || null;
    if (!updatedExpense) {
      throw new Error("Expense not found");
    }

    const relatedLease = updatedExpense?.lease_id ? await baseLeaseService.get(updatedExpense.lease_id) : null;
    await this.classifyExpenses({
      expenses: [updatedExpense],
      leases: relatedLease ? [relatedLease] : [],
    });
    return {
      ...updatedExpense,
      recovery_reason: reason,
    };
  },

  // Server-owned, audited replacement for this action's classification
  // write (Phase 6X-6: save_lease_rule_amount_cam_input RPC /
  // save-lease-rule-amount-cam-input edge function). Investigation found
  // the prior direct-write "no existing row" branch had a real bug: it
  // sent expense_id: null into a NOT NULL column, silently swallowed by
  // upsertExpenseClassification's try/catch -- the classification row was
  // never actually created, even though the UI toasted success. The RPC
  // fixes this (expense_id is now nullable for this bookkeeping row type)
  // and unifies the old update/create branches into one server-side
  // lock-and-branch upsert, keyed the same way the client used to look it
  // up (lease_expense_rule_id + row_type='rule_missing_actual').
  async createLeaseRuleAmountCamInput(rule, amount, currentYear) {
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount < 0) {
      throw new Error("Enter a valid amount");
    }
    if (!rule?.id) {
      throw new Error("Lease expense rule not found");
    }
    if (!leaseExpenseRuleService.isRuleCamPublishable(rule)) {
      throw new Error("Only approved, CAM-eligible lease rules can receive a CAM rule amount.");
    }

    const orgId = await getCurrentOrgId();
    const fiscalYear = Number(currentYear || new Date().getFullYear());
    const leaseId = rule.lease_id || rule.rule_set?.lease_id || null;
    const tenantId = rule.tenant_id || rule.rule_set?.tenant_id || null;
    const classificationKey = buildClassificationKey({
      orgId: rule.org_id || orgId,
      expenseId: `rule_amount:${rule.id}:${fiscalYear}`,
      leaseExpenseRuleId: rule.id,
    });

    if (rule.published_to_cam !== true) {
      const publishResult = await this.publishRuleToCamSetup(rule.id);
      rule.published_to_cam = publishResult?.rule?.published_to_cam === true;
    }

    const result = await invokeEdgeFunction("save-lease-rule-amount-cam-input", {
      rule_id: rule.id,
      classification: {
        classification_key: classificationKey,
        category: rule.expense_category || rule.category_name || null,
        subcategory: rule.expense_subcategory || null,
        property_id: rule.property_id || rule.rule_set?.property_id || null,
        building_id: rule.building_id || rule.rule_set?.building_id || null,
        unit_id: rule.unit_id || rule.rule_set?.unit_id || null,
        lease_id: leaseId,
        tenant_id: tenantId,
        amount: numericAmount,
        fiscal_year: fiscalYear,
      },
    });
    const classification = result?.classification || null;

    try {
      await invokeEdgeFunction("update-lease-expense-rule-amount", {
        rule_id: rule.id,
        lease_id: leaseId,
        amount: numericAmount,
      });
    } catch (error) {
      console.warn("[expenseService] lease rule amount persistence warning:", error);
    }

    const camSendResult = classification?.id
      ? await sendExpenseClassificationToCam({
        classificationId: classification.id,
        reason: "CAM rule amount entered by reviewer",
        idempotencyKey: createExpenseClassificationCamSendIdempotencyKey(classification.id),
      })
      : null;

    return camSendResult || classification || { lease_expense_rule_id: rule.id, amount: numericAmount };
  },

  async createActualExpenseFromCoverageGap(rule, amount, currentYear) {
    return this.createLeaseRuleAmountCamInput(rule, amount, currentYear);
  },

  // Server-owned, audited replacement for this action's classification
  // write (Phase 6X-6: manual_override_expense_classification RPC /
  // manual-override-expense-classification edge function). Investigation
  // found that none of manual_override/override_reason/override_type/
  // override_previous_value/override_new_value/override_source exist as
  // columns on expense_classifications -- every prior call silently
  // stripped all of them via the missing-column retry loop, persisting
  // only classification_status/reviewed_by/reviewed_at/approved_by/
  // approved_at. The RPC keeps that same real persisted-column behavior,
  // but now finally records override_reason/override_type/
  // override_previous_value/override_new_value in the audit row's
  // metadata instead of silently discarding them.
  async markManualOverride(classificationId, payload) {
    const result = await invokeEdgeFunction("manual-override-expense-classification", {
      classification_id: classificationId,
      override_reason: payload.override_reason,
      override_type: payload.override_type,
      override_previous_value: payload.override_previous_value,
      override_new_value: payload.override_new_value,
    });
    return result?.classification ?? null;
  },

  async finalizeExpenseClassification(classificationOrExpenseId, recoveryStatus = "recoverable") {
    let classification =
      classificationOrExpenseId && typeof classificationOrExpenseId === "object"
        ? classificationOrExpenseId
        : null;
    const expenseId =
      classification?.expense_id ||
      classification?.actual_expense_id ||
      (typeof classificationOrExpenseId === "string" ? classificationOrExpenseId : null);

    if (!expenseId) {
      throw new Error("Expense classification row not found");
    }

    let expense = await baseExpenseService.get(expenseId);

    if (!classification?.id) {
      classification = (await fetchExistingExpenseClassifications([expenseId]))[0] || null;
    }

    if (!classification?.id && expense) {
      const relatedLease = expense.lease_id ? await baseLeaseService.get(expense.lease_id) : null;
      await this.classifyExpenses({
        expenses: [expense],
        leases: relatedLease ? [relatedLease] : [],
      });
      classification = (await fetchExistingExpenseClassifications([expenseId]))[0] || null;
      expense = await baseExpenseService.get(expenseId);
    }

    // ── Hard-block eligibility gate (Batch D, F7) ──────────────────────
    // Refuse to finalize a row whose actual expense or linked rule fails
    // the centralized eligibility helpers. Without this, the UI could
    // finalize coverage-gap / original_lease_required / draft rows and the
    // resulting state would diverge from the loader's view of the workspace.
    if (expense && !isActualClassificationEligible(expense, { scopeMatch: true })) {
      const reason = getActualClassificationExclusionReason(expense, { scopeMatch: true });
      throw new ClassificationEligibilityError(
        `Cannot finalize: actual expense is not classification-eligible (${reason}).`,
        { reason },
      );
    }
    const ruleIdForFinalize =
      classification?.lease_expense_rule_id || classification?.linked_expense_rule_id || null;
    if (ruleIdForFinalize) {
      const { data: linkedRule, error: linkedRuleErr } = await supabase
        .from("lease_expense_rules")
        .select("*")
        .eq("id", ruleIdForFinalize)
        .maybeSingle();
      if (linkedRuleErr) throw linkedRuleErr;
      if (linkedRule && !isRuleClassificationEligible(linkedRule, { scopeMatch: true })) {
        const reason = getRuleClassificationExclusionReason(linkedRule, { scopeMatch: true });
        throw new ClassificationEligibilityError(
          `Cannot finalize: linked rule is not classification-eligible (${reason}).`,
          { reason },
        );
      }
    }

    if (!classification?.id) {
      throw new Error(`Cannot finalize: no expense classification row found for expense ${expenseId}`);
    }

    // Finalize is now a single server-owned, audited RPC call — see
    // review_expense_classification (20260710000000_review_expense_classification.sql).
    // It updates both `expenses` and `expense_classifications` in one
    // transaction and writes exactly one audit_logs row; it never
    // fabricates success on failure (invokeEdgeFunction throws on any
    // network/edge-function/RPC error instead of returning an optimistic
    // fallback object).
    const result = await reviewExpenseClassification({
      classificationId: classification.id,
      action: "finalize",
      recoveryStatus,
    });

    console.log(`[Diagnostics] Finalized classification ${classification.id}`);
    return result?.row || null;
  },

  async reopenExpenseClassification(classificationOrExpenseId) {
    let classification =
      classificationOrExpenseId && typeof classificationOrExpenseId === "object"
        ? classificationOrExpenseId
        : null;
    const expenseId =
      classification?.expense_id ||
      classification?.actual_expense_id ||
      (typeof classificationOrExpenseId === "string" ? classificationOrExpenseId : null);

    if (!expenseId) {
      throw new Error("Expense classification row not found");
    }

    if (!classification?.id) {
      classification = (await fetchExistingExpenseClassifications([expenseId]))[0] || null;
    }

    if (!classification?.id) {
      throw new Error(`Cannot reopen: no expense classification row found for expense ${expenseId}`);
    }

    // Reopen is now a single server-owned, audited RPC call — see
    // review_expense_classification (20260710000000_review_expense_classification.sql).
    // The previous client-side implementation also attempted a direct
    // write to `expenses` with columns that don't exist on that table
    // (classification_status/finalized_at/cam_status/next_step/reviewed_at
    // only exist on expense_classifications, confirmed via schema
    // inspection) — that call was a silent no-op; this RPC only writes
    // expense_classifications, the table that actually held the meaningful
    // state.
    const result = await reviewExpenseClassification({
      classificationId: classification.id,
      action: "reopen",
    });

    return result?.row || null;
  },

  async sendExpenseClassificationToReview(classificationOrExpenseId) {
    const authResult = await supabase?.auth?.getUser?.();
    const now = new Date().toISOString();
    const userId = authResult?.data?.user?.id || null;
    const classificationArg =
      classificationOrExpenseId && typeof classificationOrExpenseId === "object"
        ? classificationOrExpenseId
        : null;
    const expenseId =
      classificationArg?.expense_id ||
      classificationArg?.actual_expense_id ||
      (typeof classificationOrExpenseId === "string" ? classificationOrExpenseId : null);

    if (!expenseId) {
      throw new Error("Expense classification row not found");
    }

    // Phase 6X-1: previously two separate direct writes (a direct
    // expense_classifications update via updateExpenseClassificationRecord,
    // plus a direct expenses.recovery_status write via
    // persistExpenseWorkflowPatch). Unified into one
    // persist-expense-classification call, same as reviewExpense()/
    // classifyExpenses() — fetch the full existing row first (matching
    // those functions' own merge pattern) so this sparse "send to
    // exception queue" patch doesn't blank out unrelated classification
    // fields, then persist both tables in one transaction.
    const [existingRows, expense, orgIdFallback] = await Promise.all([
      fetchExistingExpenseClassifications([expenseId]),
      baseExpenseService.get(expenseId).catch(() => null),
      getCurrentOrgId(),
    ]);
    const existingClassification = existingRows[0] || classificationArg || null;
    const merged = { ...existingClassification, ...classificationArg };

    const recoveryStatus = merged.recovery_status || merged.recoverability_result || "needs_review";
    const orgId = merged.org_id || expense?.org_id || orgIdFallback;
    const linkedExpenseRuleId =
      merged.lease_expense_rule_id || merged.linked_expense_rule_id || merged.recovery_rule_id || null;

    await upsertExpenseClassification({
      id: merged.id,
      org_id: orgId,
      expense_id: expenseId,
      actual_expense_id: expenseId,
      classification_key:
        merged.classification_key ||
        buildClassificationKey({ orgId, expenseId, leaseExpenseRuleId }),
      property_id: merged.property_id || expense?.property_id || null,
      building_id: merged.building_id || expense?.building_id || null,
      unit_id: merged.unit_id || expense?.unit_id || null,
      lease_id: merged.lease_id || expense?.lease_id || null,
      tenant_id: merged.tenant_id || expense?.tenant_id || null,
      recovery_rule_id: linkedExpenseRuleId,
      linked_expense_rule_id: linkedExpenseRuleId,
      lease_expense_rule_id: linkedExpenseRuleId,
      category: merged.category || expense?.category || null,
      subcategory: merged.subcategory || null,
      amount: merged.amount ?? (Number.isFinite(Number(expense?.amount)) ? Number(expense.amount) : 0),
      service_period_start: merged.service_period_start || null,
      service_period_end: merged.service_period_end || null,
      recovery_status: recoveryStatus,
      recoverability_result: merged.recoverability_result || recoveryStatus,
      cam_eligible: merged.cam_eligible || "needs_review",
      recovery_method: merged.recovery_method || null,
      recovery_reason: merged.recovery_reason || merged.notes || null,
      allocation_method: merged.allocation_method || "pro_rata",
      allocation_basis: merged.allocation_basis || "pro_rata",
      cap_applied: Boolean(merged.cap_applied),
      exclusion_applied: Boolean(merged.exclusion_applied),
      condition_applied: Boolean(merged.condition_applied),
      condition_reason: merged.condition_reason || null,
      condition_resolved: merged.condition_resolved ?? true,
      condition_result: merged.condition_result || null,
      rule_source: merged.rule_source || "manual",
      confidence_score: merged.confidence_score ?? 0,
      evidence_text: merged.evidence_text || null,
      approved_status: merged.approved_status || "needs_review",
      classification_status: "exception",
      exception_type: "manual_review",
      finalized_at: merged.finalized_at || null,
      sent_to_cam: Boolean(merged.sent_to_cam),
      cam_status: merged.cam_status || "needs_review",
      cam_source: merged.cam_source || "none",
      next_step: "Resolve exception",
      notes: merged.notes || null,
      reviewed_at: now,
      reviewed_by: userId,
      classified_at: merged.classified_at || now,
      classified_by: merged.classified_by || userId,
    }, {
      expensePatch: { recovery_status: recoveryStatus },
    });

    return { id: expenseId, recovery_status: recoveryStatus, updated_at: now };
  },

  async sendClassificationToCam(classificationOrId, { reason = "" } = {}) {
    let classification =
      classificationOrId && typeof classificationOrId === "object"
        ? classificationOrId
        : await selectExpenseClassifications({
          columns: [
            "id",
            "org_id",
            "expense_id",
            "actual_expense_id",
            "lease_expense_rule_id",
            "property_id",
            "building_id",
            "unit_id",
            "lease_id",
            "tenant_id",
            "category",
            "amount",
            "recoverability_result",
            "recovery_status",
            "classification_status",
            "approved_status",
            "cam_eligible",
            "recovery_method",
            "sent_to_cam",
            "cam_status",
            "cam_source",
            "cam_input_type",
            "manual_cam_reviewed",
          ],
          apply: (query) => query.eq("id", classificationOrId).limit(1),
        }).then((rows) => rows[0] || null);

    if (!classification?.id && classification && typeof classification === "object") {
      classification = await upsertExpenseClassification({
        ...classification,
        recovery_status: classification.recovery_status || classification.recoverability_result || "needs_review",
        recoverability_result: classification.recoverability_result || classification.recovery_status || "needs_review",
        classification_status: classification.classification_status || "unmatched",
        approved_status: classification.approved_status || "needs_review",
        cam_eligible: classification.cam_eligible || "needs_review",
        cam_status: classification.cam_status || "needs_review",
        cam_source: classification.cam_source || "none",
        cam_input_type: "actual_expense",
        next_step: classification.next_step || "Review exception",
      });
    }

    if (!classification?.id) {
      throw new Error("Run Classification before sending to CAM.");
    }

    const expenseId = classification.expense_id || classification.actual_expense_id;
    const ruleId =
      classification.lease_expense_rule_id ||
      classification.linked_expense_rule_id ||
      null;
    const [expense, ruleResult] = await Promise.all([
      expenseId ? baseExpenseService.get(expenseId) : Promise.resolve(null),
      ruleId
        ? supabase.from("lease_expense_rules").select("*").eq("id", ruleId).single()
        : Promise.resolve({ data: null, error: null }),
    ]);

    if (ruleResult?.error) {
      throw ruleResult.error;
    }

    const rule = ruleResult?.data || null;

    // ── Hard-block CAM eligibility gate (Batch D, F12) ────────────────
    // Spec: CAM may only consume cam_eligible="yes" classifications. A manual
    // reason can no longer override this — the gate ran too loose, allowing
    // needs_review / conditional rows to be marked sent_to_cam with a free-form
    // reason. The compute-cam edge function rejects downstream, but the
    // classification row stayed marked, producing UI/state drift.
    if (String(classification.cam_eligible || "").toLowerCase() !== "yes") {
      throw new CamEligibilityError(
        `Cannot send to CAM: classification cam_eligible="${classification.cam_eligible || "missing"}". Resolve the row in Expense Review first.`,
        { reason: classification.cam_eligible || "missing_cam_eligible" },
      );
    }
    if (rule && !isRuleCamEligible(rule, { scopeMatch: true })) {
      const reason = getRuleCamExclusionReason(rule, { scopeMatch: true });
      throw new CamEligibilityError(
        `Cannot send to CAM: linked rule is not CAM-eligible (${reason}).`,
        { reason },
      );
    }

    // ── Tenant resolution gate (tenant resolver, F-tenant) ─────────────
    // Per-tenant CAM allocation (pro_rata_share / fixed_monthly / base_year /
    // expense_stop / pass_through / monthly_reimbursement) requires a tenant.
    // If the linked rule requires per-tenant allocation but the actual
    // expense has no resolvable tenant, the CAM compute step cannot assign
    // a share. Block here so the row stays in Expense Review until a tenant
    // is linked. Rules with property-level allocation (e.g. allocation_basis
    // = "property") are unaffected.
    if (expense && ruleRequiresPerTenantAllocation(rule)) {
      // Cheapest possible lookup — read the lease + unit only if we have ids;
      // skip the tenants table because tenant_name on the expense or lease is
      // a sufficient positive signal.
      const tenantLeases = expense.lease_id
        ? [await baseLeaseService.get(expense.lease_id).catch(() => null)].filter(Boolean)
        : [];
      const resolution = resolveTenantForExpense(expense, {
        leases: tenantLeases,
        units: [], // unit-side lookup not available server-side; the resolver
        // still resolves via expense.tenant_name / tenant_id / lease.
        tenants: [],
      });
      if (!resolution.tenant?.name && !resolution.tenant?.id) {
        throw new CamEligibilityError(
          `Cannot send to CAM: tenant unresolved (${resolution.reason}) but the linked rule requires per-tenant allocation. Link a tenant or lease to the expense in Expense Review first.`,
          { reason: `tenant_unresolved_${resolution.reason}` },
        );
      }
    }

    const isAutomatic =
      Boolean(rule) &&
      classification.recoverability_result === "recoverable" &&
      classification.cam_eligible === "yes" &&
      rule.published_to_cam === true;
    const manualReason = String(reason || classification.manual_cam_reason || "").trim();
    if (!isAutomatic && !manualReason) {
      throw new Error("Enter a reason before manually sending an unmatched or needs-review actual expense to CAM.");
    }
    if (!canSendClassificationToCam({ classification, expense, rule, manualReason })) {
      throw new Error("Only CAM-ready actual expense rows can be sent to CAM.");
    }

    const result = await sendExpenseClassificationToCam({
      classificationId: classification.id,
      reason: manualReason || null,
      idempotencyKey: createExpenseClassificationCamSendIdempotencyKey(classification.id),
    });
    console.log(`[Diagnostics] Sent classification ${classification.id} to CAM via server workflow`);
    return result?.classification || result;
  },

  async publishRuleToCamSetup(ruleId) {
    const { data: rule, error: fetchError } = await supabase
      .from("lease_expense_rules")
      .select("*")
      .eq("id", ruleId)
      .single();

    if (fetchError) {
      throw new Error("Failed to load rule before publishing to CAM setup");
    }
    if (rule?.published_to_cam === true) {
      return { rule, already_published: true };
    }
    if (!leaseExpenseRuleService.isRuleCamPublishable(rule)) {
      throw new Error("Only approved, recoverable, CAM-eligible rules can be published to CAM setup.");
    }

    const result = await publishLeaseExpenseRuleToCam({
      ruleId,
      idempotencyKey: createRuleReviewIdempotencyKey(ruleId, "publish_to_cam"),
    });
    console.log(`[Diagnostics] Published rule ${ruleId} to CAM setup via server workflow`);
    return result;
  },

  async getWorkflowSummary({ propertyId = null, buildingId = null, unitId = null, fiscalYear = null } = {}) {
    const [leases, expenses] = await Promise.all([
      baseLeaseService.list(),
      baseExpenseService.list(),
    ]);

    const scopedLeases = (leases || []).filter((lease) => {
      if (propertyId && lease.property_id !== propertyId) return false;
      if (buildingId && lease.building_id && lease.building_id !== buildingId) return false;
      if (unitId && lease.unit_id && lease.unit_id !== unitId) return false;
      if (fiscalYear && !leaseOverlapsFiscalYear(lease, fiscalYear)) return false;
      return true;
    });

    const scopedExpenses = (expenses || []).filter((expense) => {
      if (propertyId && expense.property_id !== propertyId) return false;
      if (buildingId && expense.building_id && expense.building_id !== buildingId) return false;
      if (unitId && expense.unit_id && expense.unit_id !== unitId) return false;
      if (fiscalYear && expense.fiscal_year && Number(expense.fiscal_year) !== Number(fiscalYear)) return false;
      return true;
    });

    const leaseIds = scopedLeases.map((lease) => lease.id).filter(Boolean);
    const { rules } = await fetchApprovedRuleArtifacts(leaseIds);
    const approvedCamRuleLeaseIds = new Set((rules || []).filter((rule) =>
      approvedRuleForMatching(rule) &&
      rule?.published_to_cam === true &&
      leaseExpenseRuleService.getRecoverableDecision(rule) === "yes" &&
      normalizeText(rule?.cam_eligible) === "yes" &&
      !["tenant_direct_contract", "included_in_base_rent"].includes(normalizeText(rule?.payment_treatment)) &&
      rule?.is_excluded !== true &&
      ![rule?.row_status, rule?.status, rule?.extraction_status].some((value) => normalizeText(value) === "superseded")
    ).map((rule) => rule.lease_id).filter(Boolean));

    const actualExpenses = scopedExpenses.filter((expense) => normalizeSourceType(expense) !== "lease_import");
    const approvedActualById = new Map(actualExpenses.filter((expense) => isApprovedExpenseRecord(expense)).map((expense) => [String(expense.id), expense]));
    const needsReviewExpenses = actualExpenses.filter((expense) => normalizeText(expense.approved_status) === "needs_review" || normalizeText(expense.recovery_status) === "needs_review");
    const missingCategoryExpenses = actualExpenses.filter((expense) => !expense.category && !expense.expense_subcategory);
    const conditionalExpenses = actualExpenses.filter((expense) => normalizeText(expense.recovery_status) === "conditional");
    const missingSqftLeases = scopedLeases.filter((lease) => !toNumber(lease.square_footage));
    const missingDatesLeases = scopedLeases.filter((lease) => !lease.start_date || !lease.end_date);
    const scopeForRow = { property_id: propertyId, building_id: buildingId, unit_id: unitId, fiscal_year: fiscalYear };

    let camReadyClassificationCount = 0;
    let camReadyInputCount = 0;
    let blockingCamNeedsReviewCount = 0;
    try {
      const [{ data: classifications }, { data: camInputs }] = await Promise.all([
        supabase
          .from("expense_classifications")
          .select("*"),
        supabase
          .from("cam_expense_inputs")
          .select("*")
          .eq("status", "cam_ready"),
      ]);

      const scopedClassifications = (classifications || []).filter((row) => expenseMatchesScope(row, scopeForRow));
      camReadyClassificationCount = scopedClassifications.filter((row) => {
        if (!expenseMatchesScope(row, scopeForRow)) return false;
        if (normalizeText(row?.cam_status) !== "cam_ready") return false;
        if (normalizeText(row?.cam_eligible) !== "yes") return false;
        if (normalizeText(row?.cam_input_type) !== "actual_expense") return false;
        if (normalizeText(row?.cam_source) === "manual_review" && !String(row?.manual_cam_reason || row?.manual_cam_note || "").trim()) return false;
        const actualExpenseId = String(row?.expense_id || row?.actual_expense_id || "");
        return actualExpenseId && approvedActualById.has(actualExpenseId);
      }).length;
      blockingCamNeedsReviewCount = scopedClassifications.filter((row) =>
        normalizeText(row?.cam_status) === "needs_review" &&
        ["yes", "conditional", "needs_review"].includes(normalizeText(row?.cam_eligible))
      ).length;

      camReadyInputCount = (camInputs || []).filter((row) => {
        if (!expenseMatchesScope(row, scopeForRow)) return false;
        if (!["actual_expense", "lease_rule_amount"].includes(normalizeText(row?.cam_input_type || row?.source))) return false;
        return toNumber(row?.amount) > 0;
      }).length;
    } catch (error) {
      console.warn("[expenseService] CAM readiness summary query failed:", error?.message || error);
    }

    return {
      scopedLeaseCount: scopedLeases.length,
      approvedLeaseCount: scopedLeases.filter((lease) => ["approved", "budget_ready", "active", "executed"].includes(normalizeLeaseStatus(lease.status))).length,
      approvedRuleLeaseCount: approvedCamRuleLeaseIds.size,
      approvedCamRuleLeaseCount: approvedCamRuleLeaseIds.size,
      camReadyClassificationCount,
      camReadyInputCount,
      blockingCamNeedsReviewCount,
      expenseCount: actualExpenses.length,
      actualExpenseCount: actualExpenses.length,
      needsReviewCount: needsReviewExpenses.length,
      conditionalExpenseCount: conditionalExpenses.length,
      missingCategoryCount: missingCategoryExpenses.length,
      missingSquareFootageCount: missingSqftLeases.length,
      missingLeaseDatesCount: missingDatesLeases.length,
      canRunCam:
        scopedLeases.length > 0 &&
        (approvedCamRuleLeaseIds.size > 0 || camReadyClassificationCount > 0 || camReadyInputCount > 0) &&
        blockingCamNeedsReviewCount === 0 &&
        missingSqftLeases.length === 0 &&
        missingDatesLeases.length === 0,
    };
  },

  async loadApprovedLeaseExpenseRules(scope = {}) {
    const {
      scope: normalizedScope,
      approvedRules,
      diagnostics,
    } = await fetchApprovedClassificationRules(scope);

    // Apply the centralized classification-eligibility gate. Rules already
    // approved by review can still be ineligible for downstream classification
    // when they carry coverage-gap, included-in-base-rent, tenant-direct, or
    // explicit-exclusion semantics. Filtering here ensures the Classification
    // page, runExpenseClassification, and CAM consumers see the same view.
    const eligibleRules = [];
    const exclusions = { ...EMPTY_RULE_EXCLUSIONS };
    for (const rule of approvedRules) {
      const reason = getRuleClassificationExclusionReason(rule, { scopeMatch: true });
      if (reason === null) {
        eligibleRules.push(rule);
      } else {
        bumpExclusion(exclusions, reason);
      }
    }

    console.log("[Classification approvedRules]", {
      scope: normalizedScope,
      approvedRulesCount: eligibleRules.length,
      rawApprovedRuleCount: diagnostics?.rawApprovedRuleCount || 0,
      accessibleApprovedRuleCount: diagnostics?.accessibleApprovedRuleCount || 0,
      reviewedButDraftCount: diagnostics?.reviewedButDraftCount || 0,
      reviewedButDraftRuleIds: diagnostics?.reviewedButDraftRuleIds || [],
      excludedByEligibility: approvedRules.length - eligibleRules.length,
      eligibilityExclusions: exclusions,
      sampleRules: eligibleRules.slice(0, 10).map((rule) => ({
        id: rule.id,
        review_status: rule.review_status,
        approval_status: rule.approval_status,
        lease_id: rule.lease_id,
        tenant_id: rule.tenant_id,
        property_id: rule.property_id,
        building_id: rule.building_id,
        unit_id: rule.unit_id,
      })),
      rulesByLease: summarizeApprovedRulesBy(eligibleRules, "lease_id"),
      rulesByTenant: summarizeApprovedRulesBy(eligibleRules, "tenant_id"),
    });
    return {
      rules: eligibleRules,
      exclusions,
      rawApprovedCount: approvedRules.length,
      classificationEligibleCount: eligibleRules.length,
    };
  },

  async loadApprovedActualExpenses(scope = {}) {
    const normalizedScope = normalizeRecoverabilityScope(scope);
    const [allExpenses, allLeases] = await Promise.all([
      listWorkflowEntityRows("Expense"),
      listWorkflowEntityRows("Lease"),
    ]);

    const approvedExpenses = [];
    const exclusions = { ...EMPTY_ACTUAL_EXCLUSIONS };
    let rawApprovedCount = 0;

    for (const rawExpense of allExpenses || []) {
      if (normalizeSourceType(rawExpense) === "lease_import") continue;

      const { expense: linkedExpense } = await this.resolveExpenseLeaseLink(rawExpense, allLeases);

      if (!isApprovedExpenseRecord(linkedExpense)) continue;
      const scopeMatch = expenseMatchesScope(linkedExpense, normalizedScope);
      rawApprovedCount += 1;

      // Centralized eligibility check (scope + extended actual filters such as
      // row_status / generation_source / draft / missing_amount). Keep the
      // legacy isApprovedExpenseRecord above so coarse approval gating still
      // runs first — the helper is the fine-grained gate.
      const reason = getActualClassificationExclusionReason(linkedExpense, { scopeMatch });
      if (reason === null) {
        approvedExpenses.push(linkedExpense);
      } else {
        bumpExclusion(exclusions, reason);
      }
    }

    console.log("[Classification approvedActuals]", {
      scope: normalizedScope,
      approvedActualsCount: approvedExpenses.length,
      rawApprovedCount,
      excludedByEligibility: rawApprovedCount - approvedExpenses.length,
      eligibilityExclusions: exclusions,
    });
    return { actuals: approvedExpenses, exclusions, rawApprovedCount };
  },

  async loadExpenseRecoverabilityScope(scope = {}) {
    const normalizedScope = normalizeRecoverabilityScope(scope);
    const safe = async (label, fn, fallback = []) => {
      try {
        return await fn();
      } catch (error) {
        console.error(`[ExpenseRecoverability] ${label} failed`, {
          code: error?.code,
          message: error?.message,
          details: error?.details,
          hint: error?.hint,
          scope: normalizedScope,
          error,
        });
        return fallback;
      }
    };

    const [rulesResult, actualsResult, existingClassifications] = await Promise.all([
      safe("approved lease rules", () => this.loadApprovedLeaseExpenseRules(normalizedScope), { rules: [], exclusions: { ...EMPTY_RULE_EXCLUSIONS }, rawApprovedCount: 0 }),
      safe("approved actual expenses", () => this.loadApprovedActualExpenses(normalizedScope), { actuals: [], exclusions: { ...EMPTY_ACTUAL_EXCLUSIONS }, rawApprovedCount: 0 }),
      safe("classification rows", () => this.listExpenseClassificationsForScope(normalizedScope)),
    ]);

    // Normalize back-compat: prior loaders returned bare arrays. Now they
    // return { rules|actuals, exclusions, rawApprovedCount }. Expose both the
    // arrays (for unchanged consumers) and the exclusion histograms (for the
    // ClassificationDebugPanel in Batch B).
    const approvedRules = Array.isArray(rulesResult) ? rulesResult : rulesResult.rules;
    const approvedActuals = Array.isArray(actualsResult) ? actualsResult : actualsResult.actuals;
    const ruleExclusions = Array.isArray(rulesResult) ? { ...EMPTY_RULE_EXCLUSIONS } : rulesResult.exclusions;
    const actualExclusions = Array.isArray(actualsResult) ? { ...EMPTY_ACTUAL_EXCLUSIONS } : actualsResult.exclusions;
    const rawApprovedRulesCount = Array.isArray(rulesResult) ? approvedRules.length : rulesResult.rawApprovedCount;
    const rawApprovedActualsCount = Array.isArray(actualsResult) ? approvedActuals.length : actualsResult.rawApprovedCount;

    const classificationEligibleCount = Array.isArray(rulesResult)
      ? approvedRules.length
      : (rulesResult.classificationEligibleCount ?? approvedRules.length);

    return {
      approvedRules,
      approvedActuals,
      existingClassifications,
      ruleExclusions,
      actualExclusions,
      summary: {
        rulesCount: approvedRules.length,
        classificationEligibleCount,
        actualsCount: approvedActuals.length,
        classificationsCount: existingClassifications.length,
        rawApprovedRulesCount,
        rawApprovedActualsCount,
        rulesExcludedCount: rawApprovedRulesCount - approvedRules.length,
        actualsExcludedCount: rawApprovedActualsCount - approvedActuals.length,
      },
    };
  },

  async loadExpenseRecoverabilityDiagnostics(scope = {}) {
    const normalizedScope = normalizeRecoverabilityScope(scope);
    const orgId = await getCurrentOrgId();
    const actingOrgId = getStoredActingOrgId();
    const authResult = await supabase?.auth?.getUser?.();
    const { me } = await import("@/services/auth");
    const currentUser = await me().catch(() => null);

    const [allLeases, allExpenses] = await Promise.all([
      listWorkflowEntityRows("Lease"),
      listWorkflowEntityRows("Expense"),
    ]);

    const leaseById = new Map((allLeases || []).map((lease) => [lease.id, lease]));
    const { allApprovedRules: approvedRulesOrg } = await fetchApprovedClassificationRules({});

    const approvedActualsOrg = (allExpenses || []).filter((expense) =>
      normalizeSourceType(expense) !== "lease_import" && isApprovedExpenseRecord(expense)
    );

    let allClassifications = [];
    try {
      allClassifications = await selectExpenseClassifications({
        columns: ["id", "org_id", "expense_id", "actual_expense_id", "lease_expense_rule_id", "classification_key"],
        apply: (query) => {
          if (orgId && orgId !== "__none__" && orgId !== null) {
            return query.eq("org_id", orgId);
          }
          return query;
        },
      });
    } catch (error) {
      console.warn("[expenseService] recoverability diagnostics classification read warning:", error);
    }

    const rulesMatchingProperty = approvedRulesOrg.filter((rule) => ruleMatchesScope(rule, leaseById.get(rule.lease_id || rule.rule_set?.lease_id) || null, { ...normalizedScope, building_id: null, unit_id: null, lease_id: null, tenant_id: null, fiscal_year: null }));
    const rulesMatchingBuilding = approvedRulesOrg.filter((rule) => ruleMatchesScope(rule, leaseById.get(rule.lease_id || rule.rule_set?.lease_id) || null, { ...normalizedScope, unit_id: null, lease_id: null, tenant_id: null, fiscal_year: null }));
    const rulesMatchingUnit = approvedRulesOrg.filter((rule) => ruleMatchesScope(rule, leaseById.get(rule.lease_id || rule.rule_set?.lease_id) || null, { ...normalizedScope, lease_id: null, tenant_id: null, fiscal_year: null }));
    const rulesMatchingLease = approvedRulesOrg.filter((rule) => ruleMatchesScope(rule, leaseById.get(rule.lease_id || rule.rule_set?.lease_id) || null, { ...normalizedScope, tenant_id: null, fiscal_year: null }));

    const actualsMatchingProperty = approvedActualsOrg.filter((expense) => expenseMatchesScope(expense, { ...normalizedScope, building_id: null, unit_id: null, lease_id: null, tenant_id: null, fiscal_year: null }));
    const actualsMatchingBuilding = approvedActualsOrg.filter((expense) => expenseMatchesScope(expense, { ...normalizedScope, unit_id: null, lease_id: null, tenant_id: null, fiscal_year: null }));
    const actualsMatchingUnit = approvedActualsOrg.filter((expense) => expenseMatchesScope(expense, { ...normalizedScope, lease_id: null, tenant_id: null, fiscal_year: null }));
    const actualsMatchingLease = approvedActualsOrg.filter((expense) => expenseMatchesScope(expense, { ...normalizedScope, tenant_id: null, fiscal_year: null }));
    const scopedApprovedRules = approvedRulesOrg.filter((rule) =>
      ruleMatchesScope(rule, leaseById.get(rule.lease_id || rule.rule_set?.lease_id) || null, normalizedScope)
    );
    const scopedApprovedActuals = approvedActualsOrg.filter((expense) => expenseMatchesScope(expense, normalizedScope));

    const first10ApprovedExpenses = scopedApprovedActuals.slice(0, 10).map(e => ({
      id: e.id,
      org_id: e.org_id,
      property_id: e.property_id,
      building_id: e.building_id,
      unit_id: e.unit_id,
      lease_id: e.lease_id,
      tenant_id: e.tenant_id,
      category: e.category,
      amount: e.amount,
      approval_status: e.approval_status || e.approved_status,
      review_status: e.review_status
    }));

    const first10ApprovedRules = scopedApprovedRules.slice(0, 10).map(r => ({
      id: r.id,
      org_id: r.org_id,
      lease_id: r.lease_id,
      property_id: r.property_id,
      building_id: r.building_id,
      unit_id: r.unit_id,
      tenant_id: r.tenant_id,
      expense_category: r.expense_category || r.category_name,
      approval_status: r.approval_status || r.approved_status,
      review_status: r.review_status,
      source_page: r.source_page
    }));

    const diagnostics = {
      current_user_id: authResult?.data?.user?.id || currentUser?.id || null,
      org_id: currentUser?.org_id || null,
      acting_org_id: actingOrgId,
      selected_scope: normalizedScope,
      raw_expenses_count_for_org: (allExpenses || []).length,
      approved_expenses_count_before_scope: approvedActualsOrg.length,
      approved_expenses_count_after_scope: scopedApprovedActuals.length,
      first_10_approved_expenses: first10ApprovedExpenses,
      raw_lease_expense_rules_count_for_org: approvedRulesOrg.length,
      approved_lease_rules_count_before_scope: approvedRulesOrg.length,
      approved_lease_rules_count_after_scope: scopedApprovedRules.length,
      first_10_approved_rules: first10ApprovedRules,
      rules_matching_property_count: rulesMatchingProperty.length,
      rules_matching_building_count: rulesMatchingBuilding.length,
      rules_matching_unit_count: rulesMatchingUnit.length,
      rules_matching_lease_count: rulesMatchingLease.length,
      actuals_matching_property_count: actualsMatchingProperty.length,
      actuals_matching_building_count: actualsMatchingBuilding.length,
      actuals_matching_unit_count: actualsMatchingUnit.length,
      actuals_matching_lease_count: actualsMatchingLease.length,
      expense_classifications_count_for_org: allClassifications.length,
      finalized_classifications_count: allClassifications.filter(c => c.classification_status === "finalized").length,
      excluded_expenses_with_reason: approvedActualsOrg.filter(e => !expenseMatchesScope(e, normalizedScope)).map(e => ({ id: e.id, reason: "out of scope" })),
      excluded_rules_with_reason: approvedRulesOrg.filter(r => !ruleMatchesScope(r, leaseById.get(r.lease_id || r.rule_set?.lease_id) || null, normalizedScope)).map(r => ({ id: r.id, reason: "out of scope" }))
    };

    console.group("[ExpenseRecoverability] diagnostic trace");
    console.table([{
      current_user_id: diagnostics.current_user_id,
      org_id: diagnostics.org_id,
      acting_org_id: diagnostics.acting_org_id,
      raw_expenses_count_for_org: diagnostics.raw_expenses_count_for_org,
      approved_expenses_count_before_scope: diagnostics.approved_expenses_count_before_scope,
      approved_expenses_count_after_scope: diagnostics.approved_expenses_count_after_scope,
      raw_lease_expense_rules_count_for_org: diagnostics.raw_lease_expense_rules_count_for_org,
      approved_lease_rules_count_before_scope: diagnostics.approved_lease_rules_count_before_scope,
      approved_lease_rules_count_after_scope: diagnostics.approved_lease_rules_count_after_scope,
      expense_classifications_count_for_org: diagnostics.expense_classifications_count_for_org,
      finalized_classifications_count: diagnostics.finalized_classifications_count,
    }]);
    if (diagnostics.first_10_approved_expenses.length > 0) {
      console.log("First 10 approved expenses:");
      console.table(diagnostics.first_10_approved_expenses);
    }
    if (diagnostics.first_10_approved_rules.length > 0) {
      console.log("First 10 approved rules:");
      console.table(diagnostics.first_10_approved_rules);
    }
    if (diagnostics.excluded_expenses_with_reason.length > 0) {
      console.log("Excluded expenses:", diagnostics.excluded_expenses_with_reason);
    }
    if (diagnostics.excluded_rules_with_reason.length > 0) {
      console.log("Excluded rules:", diagnostics.excluded_rules_with_reason);
    }
    console.groupEnd();

    return diagnostics;
  },

  async runExpenseClassification(scope = {}) {
    const { approvedRules, approvedActuals } = await this.loadExpenseRecoverabilityScope(scope);
    if (approvedRules.length === 0 && approvedActuals.length === 0) return { updated: 0, classified: 0, needsReview: 0 };
    if (approvedActuals.length === 0) return { updated: 0, classified: 0, needsReview: 0 };

    const rulesByLeaseId = new Map();
    approvedRules.forEach(r => {
      const lId = r.rule_set?.lease_id || r.lease_id;
      if (!rulesByLeaseId.has(lId)) rulesByLeaseId.set(lId, []);
      rulesByLeaseId.get(lId).push(r);
    });

    const leases = await listWorkflowEntityRows("Lease");

    return await this.classifyExpenses({
      expenses: approvedActuals,
      leases: leases,
      approvedRules: approvedRules,
      rulesByLeaseId: rulesByLeaseId,
      scope: scope
    });
  },
};

// Named export for golden regression tests; keep service facade unchanged.
export { scoreRuleMatch, buildAmountBuckets, canSendClassificationToCam };
export default expenseService;
