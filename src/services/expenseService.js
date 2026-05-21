import { createEntityService, getCurrentOrgId } from "@/services/api";
import { supabase } from "@/services/supabaseClient";
import { leaseExpenseRuleService } from "@/services/leaseExpenseRuleService";
import { getStoredActingOrgId } from "@/lib/actingOrg";
import { resolveTableName } from "@/types";

const baseExpenseService = createEntityService("Expense");
const baseLeaseService = createEntityService("Lease");

const LEASE_DERIVED_EXPENSES = [
  { field: "cam_amount", category: "cam", label: "CAM" },
  { field: "nnn_amount", category: "nnn", label: "NNN" },
  { field: "insurance_reimbursement_amount", category: "insurance", label: "Insurance Reimbursement" },
  { field: "tax_reimbursement_amount", category: "taxes", label: "Tax Reimbursement" },
  { field: "utility_reimbursement_amount", category: "utilities", label: "Utility Reimbursement" },
  { field: "water_sewer_reimbursement_amount", category: "utilities", label: "Water / Sewer Reimbursement" },
  { field: "pet_rent_amount", category: "pet_rent", label: "Pet Rent" },
  { field: "parking_fee_amount", category: "parking", label: "Parking Fee" },
];

const SYNCABLE_LEASE_STATUSES = new Set(["active", "approved", "budget_ready", "executed"]);
const CONDITIONAL_KEYWORDS = ["subject to", "provided that", "unless", "if ", "condition", "gross-up", "base year", "cap"];

function toNumber(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function asNumberOrNull(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeLeaseStatus(status) {
  return normalizeText(status);
}

function normalizeRuleStatus(rule) {
  return normalizeText(rule?.row_status);
}

function normalizeRecoveryStatus(rule) {
  return leaseExpenseRuleService.normalizeRecoveryStatus(rule);
}

function leaseOverlapsFiscalYear(lease, fiscalYear) {
  if (!fiscalYear) return true;

  const start = lease?.start_date ? new Date(`${lease.start_date}T00:00:00`) : null;
  const end = lease?.end_date ? new Date(`${lease.end_date}T23:59:59`) : null;
  const yearStart = new Date(fiscalYear, 0, 1);
  const yearEnd = new Date(fiscalYear, 11, 31, 23, 59, 59);

  if (start && Number.isNaN(start.getTime())) return true;
  if (end && Number.isNaN(end.getTime())) return true;
  if (start && start > yearEnd) return false;
  if (end && end < yearStart) return false;
  return true;
}

function deriveLeaseExpenseFiscalYear(lease) {
  const currentYear = new Date().getFullYear();
  if (leaseOverlapsFiscalYear(lease, currentYear)) return currentYear;

  const startYear = lease?.start_date ? new Date(`${lease.start_date}T00:00:00`).getFullYear() : null;
  if (Number.isFinite(startYear)) return startYear;

  const endYear = lease?.end_date ? new Date(`${lease.end_date}T00:00:00`).getFullYear() : null;
  if (Number.isFinite(endYear)) return endYear;

  return currentYear;
}

function deriveLeaseExpenseDate(lease, fiscalYear) {
  const startDate = typeof lease?.start_date === "string" ? lease.start_date : "";
  if (startDate && startDate.startsWith(`${fiscalYear}-`)) {
    return startDate;
  }
  return `${fiscalYear}-01-01`;
}

function expenseSyncKey({ lease_id, category, fiscal_year, source_type }) {
  return [lease_id || "", category || "", fiscal_year || "", source_type || ""].join("::");
}

function buildPropertyLookup(properties = []) {
  if (properties instanceof Map) return properties;
  return new Map((properties || []).map((property) => [property.id, property]));
}

function buildLeaseLookup(leases = []) {
  return new Map((leases || []).map((lease) => [lease.id, lease]));
}

function normalizeSourceType(expense) {
  return expense?.source_type || expense?.source || "manual";
}

function getLeaseExtractedValue(lease, fieldName) {
  if (!lease || !fieldName) return null;
  if (lease[fieldName] != null && lease[fieldName] !== "") return lease[fieldName];

  const extractedFields = lease?.extracted_fields && typeof lease.extracted_fields === "object"
    ? lease.extracted_fields
    : lease?.extraction_data?.extracted_fields && typeof lease.extraction_data.extracted_fields === "object"
      ? lease.extraction_data.extracted_fields
      : null;

  if (extractedFields && extractedFields[fieldName] != null && extractedFields[fieldName] !== "") {
    return extractedFields[fieldName];
  }

  const customFields = Array.isArray(lease?.extraction_data?.custom_fields)
    ? lease.extraction_data.custom_fields
    : [];

  const matchingCustomField = customFields.find((field) => field?.field_key === fieldName && field?.value != null && field?.value !== "");
  return matchingCustomField?.value ?? null;
}

function buildCoreLeaseDerivedPayloads(lease, propertyById) {
  const status = normalizeLeaseStatus(lease?.status);
  if (!SYNCABLE_LEASE_STATUSES.has(status)) return [];
  if (!lease?.id || !lease?.property_id) return [];

  const fiscalYear = deriveLeaseExpenseFiscalYear(lease);
  const expenseDate = deriveLeaseExpenseDate(lease, fiscalYear);
  const month = Number(expenseDate.slice(5, 7)) || 1;
  const tenantName = String(lease.tenant_name || "Lease");
  const property = propertyById.get(lease.property_id) || null;
  const extractedAmounts = Object.fromEntries(
    LEASE_DERIVED_EXPENSES.map((definition) => [
      definition.field,
      toNumber(getLeaseExtractedValue(lease, definition.field)),
    ]),
  );
  const suppressGenericUtilityCharge =
    extractedAmounts.utility_reimbursement_amount > 0 &&
    extractedAmounts.utility_reimbursement_amount === extractedAmounts.water_sewer_reimbursement_amount;

  return LEASE_DERIVED_EXPENSES.flatMap((definition) => {
    if (definition.field === "utility_reimbursement_amount" && suppressGenericUtilityCharge) {
      return [];
    }

    const amount = extractedAmounts[definition.field] ?? 0;
    if (amount <= 0) return [];

    return [{
      org_id: lease.org_id,
      portfolio_id: property?.portfolio_id || null,
      property_id: lease.property_id,
      building_id: lease.building_id || null,
      unit_id: lease.unit_id || null,
      lease_id: lease.id,
      tenant_id: lease.tenant_id || null,
      tenant_name: tenantName,
      category: definition.category,
      expense_subcategory: null,
      amount,
      classification: "recoverable",
      recovery_status: "recoverable",
      vendor: tenantName,
      vendor_name: tenantName,
      fiscal_year: fiscalYear,
      month,
      date: expenseDate,
      expense_date: expenseDate,
      source: "lease_import",
      source_type: "lease_import",
      rule_source: "lease",
      allocation_type: "direct",
      allocation_method: "direct",
      is_controllable: true,
      approved_status: "approved",
      confidence_score: 1,
      description: `${definition.label} imported from lease for ${tenantName}`,
      evidence_text: `Derived from ${definition.field}`,
      classification_updated_at: new Date().toISOString(),
      billing_period_start: lease.start_date || expenseDate,
      billing_period_end: lease.end_date || null,
    }];
  });
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
      approved_status: recoveryStatus === "conditional" ? "needs_review" : "approved",
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
    "approved_status",
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
  const approval = normalizeText(expense?.approval_status);
  const review = normalizeText(expense?.review_status);
  return approval === "approved" || review === "approved";
}

function isPendingExpenseRecord(expense) {
  const status = normalizeText(
    expense?.approved_status ||
    expense?.approval_status ||
    expense?.review_status ||
    expense?.status
  );
  return status !== "approved";
}

function approvedRuleState(rule) {
  const approval = normalizeText(rule?.approval_status);
  const review = normalizeText(rule?.review_status) === "reviewed" ? "approved" : normalizeText(rule?.review_status);
  const status = normalizeText(rule?.status);
  const rowStatus = normalizeText(rule?.row_status);

  if (["rejected"].includes(approval) || ["rejected"].includes(review) || status === "rejected") return "rejected";
  if (rowStatus === "unmapped" || rowStatus === "not_found" || rowStatus === "missing_value") return "na";
  if (approval === "approved" && review === "approved") return "approved";
  if ([approval, review, status].includes("needs_review") || rowStatus === "needs_review" || rowStatus === "uncertain" || rowStatus === "mapped") return "needs_review";
  return "draft";
}

function isApprovedLeaseRule(rule) {
  const approval = normalizeText(rule?.approval_status);
  const review = normalizeText(rule?.review_status);
  const rowStatus = normalizeText(rule?.row_status);

  if (["rejected", "unmapped", "not_found", "missing_value"].includes(rowStatus)) return false;

  return approval === "approved" && ["approved", "reviewed"].includes(review);
}

function mergeLeaseRuleSources(primaryRules = [], fallbackRules = []) {
  const mergedById = new Map();

  for (const rule of fallbackRules || []) {
    if (!rule?.id) continue;
    mergedById.set(rule.id, { ...rule });
  }

  for (const rule of primaryRules || []) {
    if (!rule?.id) continue;
    const existing = mergedById.get(rule.id) || {};
    mergedById.set(rule.id, { ...existing, ...rule });
  }

  return [...mergedById.values()];
}

function expenseMatchesScope(expense, scope = {}) {
  const { property_id, building_id, unit_id, lease_id, tenant_id, fiscal_year } = scope;

  const matchesLease = lease_id && lease_id !== "all" && String(expense.lease_id) === String(lease_id);

  if (!matchesLease) {
    if (property_id && property_id !== "all" && expense.property_id !== property_id) return false;
    if (building_id && building_id !== "all" && expense.building_id !== building_id) return false;
    if (unit_id && unit_id !== "all" && expense.unit_id !== unit_id) return false;
    if (lease_id && lease_id !== "all" && expense.lease_id !== lease_id) return false;
    if (tenant_id && tenant_id !== "all" && expense.tenant_id !== tenant_id) return false;
  }

  const status = normalizeText(expense?.status);
  if (["deleted", "void", "voided", "archived"].includes(status)) return false;

  if (fiscal_year && fiscal_year !== "all") {
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
  const { property_id, building_id, unit_id, lease_id, tenant_id, fiscal_year } = scope;
  if (lease_id && lease_id !== "all" && lease.id !== lease_id) return false;
  if (tenant_id && tenant_id !== "all" && lease.tenant_id !== tenant_id) return false;
  if (property_id && property_id !== "all" && lease.property_id !== property_id) return false;
  if (unit_id && unit_id !== "all" && lease.unit_id !== unit_id) return false;
  if (building_id && building_id !== "all") {
    const leaseBuildingId = lease.building_id || null;
    if (leaseBuildingId && leaseBuildingId !== building_id) return false;
  }
  if (!leaseOverlapsFiscalYear(lease, fiscal_year && fiscal_year !== "all" ? Number(fiscal_year) : null)) return false;
  return true;
}

function ruleMatchesScope(rule, lease, scope = {}) {
  const { property_id, building_id, unit_id, lease_id, tenant_id, fiscal_year } = scope;

  if (!isApprovedLeaseRule(rule)) return false;
  if (approvedRuleState(rule) === "na" || approvedRuleState(rule) === "rejected") return false;

  const effectiveLeaseId = rule.lease_id || lease?.id || rule.rule_set?.lease_id || null;
  const effectiveTenantId = lease?.tenant_id || rule.rule_set?.tenant_id || null;
  const effectivePropertyId = lease?.property_id || rule.rule_set?.property_id || null;
  const effectiveBuildingId = lease?.building_id || rule.rule_set?.building_id || null;
  const effectiveUnitId = lease?.unit_id || rule.rule_set?.unit_id || null;

  const matchesLease = lease_id && lease_id !== "all" && String(effectiveLeaseId) === String(lease_id);

  if (!matchesLease) {
    if (property_id && property_id !== "all" && effectivePropertyId !== property_id) return false;
    if (building_id && building_id !== "all" && effectiveBuildingId !== building_id) return false;
    if (unit_id && unit_id !== "all" && effectiveUnitId !== unit_id) return false;
    if (lease_id && lease_id !== "all" && effectiveLeaseId !== lease_id) return false;
    if (tenant_id && tenant_id !== "all" && effectiveTenantId !== tenant_id) return false;
  }

  if (fiscal_year && fiscal_year !== "all" && lease && !leaseOverlapsFiscalYear(lease, Number(fiscal_year))) {
    return false;
  }

  return true;
}

function normalizeDateCandidate(value) {
  if (!value) return null;
  const raw = String(value);
  const parsed = raw.length === 10
    ? new Date(`${raw}T00:00:00`)
    : new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function expenseServiceDate(expense) {
  return (
    expense?.expense_date ||
    expense?.date ||
    expense?.service_period_start ||
    expense?.billing_period_start ||
    expense?.period ||
    null
  );
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
  const { property_id, building_id, unit_id, lease_id, tenant_id, fiscal_year } = scope;
  
  const cProp = classification.property_id || classification.expense?.property_id || classification.lease?.property_id || null;
  const cBldg = classification.building_id || classification.expense?.building_id || classification.lease?.building_id || null;
  const cUnit = classification.unit_id || classification.expense?.unit_id || classification.lease?.unit_id || null;
  const cLease = classification.lease_id || classification.expense?.lease_id || null;
  const cTenant = classification.tenant_id || classification.expense?.tenant_id || classification.lease?.tenant_id || null;

  if (property_id && property_id !== "all" && cProp && cProp !== property_id) return false;
  if (building_id && building_id !== "all" && cBldg && cBldg !== building_id) return false;
  if (unit_id && unit_id !== "all" && cUnit && cUnit !== unit_id) return false;
  if (lease_id && lease_id !== "all" && cLease && cLease !== lease_id) return false;
  if (tenant_id && tenant_id !== "all" && cTenant && cTenant !== tenant_id) return false;

  if (fiscal_year && fiscal_year !== "all") {
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

  const paymentTreatment = normalizeText(getPaymentTreatment(rule));
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
} = {}) {
  if (sentToCam) return "Sent to CAM";
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

function canSendClassificationToCam({ classification, expense, rule }) {
  const amount = toNumber(classification?.amount ?? expense?.amount);
  const recoverabilityResult = normalizeText(classification?.recoverability_result || classification?.recovery_status);
  const camEligible = normalizeText(classification?.cam_eligible);
  const paymentTreatment = normalizeText(getPaymentTreatment(rule));

  return (
    ["recoverable", "conditional"].includes(recoverabilityResult) &&
    ["yes", "conditional"].includes(camEligible) &&
    amount > 0 &&
    !classification?.sent_to_cam &&
    paymentTreatment !== "included_in_base_rent"
  );
}

// Treat any of the lease-expense-rule supporting tables not being deployed
// as "no rules" rather than throwing — this code runs on every lease save
// and approval, and a missing optional table shouldn't break the user's
// happy path.
function isMissingExpenseRuleTable(error) {
  if (!error) return false;
  const code = String(error.code || "").toUpperCase();
  if (code === "PGRST205" || code === "42P01") return true;
  const text = String(error.message || error.details || "").toLowerCase();
  return /lease_expense_rule_sets|lease_expense_rules|lease_expense_values|lease_expense_rule_clauses|expense_categories/.test(text)
    && /does not exist|could not find/.test(text);
}

function extractMissingColumn(error) {
  const text = [error?.message, error?.details, error?.hint].filter(Boolean).join(" ");
  if (!text) return null;

  let match = text.match(/Could not find the '([^']+)' column/i);
  if (match?.[1]) return match[1];

  match = text.match(/column\s+["']?([a-zA-Z0-9_.]+)["']?/i);
  if (match?.[1]) {
    return String(match[1]).split(".").pop();
  }

  match = text.match(/column ["']?([a-zA-Z0-9_]+)["']?/i);
  if (match?.[1]) return match[1];

  return null;
}

function isMissingColumnError(error) {
  return (
    error?.code === "PGRST204" ||
    error?.code === "42703" ||
    Boolean(extractMissingColumn(error))
  );
}

function isSchemaCompatibilityError(error) {
  const text = [error?.message, error?.details, error?.hint].filter(Boolean).join(" ").toLowerCase();
  return isMissingColumnError(error) || text.includes("schema mismatch");
}

async function selectExpenseClassifications({ columns = [], apply = (query) => query } = {}) {
  if (!supabase || columns.length === 0) return [];

  const remainingColumns = [...columns];

  while (remainingColumns.length > 0) {
    let query = supabase.from("expense_classifications").select(remainingColumns.join(", "));
    query = apply(query);

    const { data, error } = await query;
    if (!error) {
      return data || [];
    }

    const missingColumn = extractMissingColumn(error);
    if (!isMissingColumnError(error) || !missingColumn) {
      throw error;
    }

    const index = remainingColumns.indexOf(missingColumn);
    if (index === -1) {
      throw error;
    }
    remainingColumns.splice(index, 1);
  }

  return [];
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

  const latestRuleSets = [...ruleSetsByLease.values()]
    .map((setsForLease) =>
      setsForLease.find((ruleSet) =>
        ["approved"].includes(normalizeText(ruleSet?.status))
      ) || setsForLease[0]
    )
    .filter(Boolean);

  const ruleSetIds = latestRuleSets.map((ruleSet) => ruleSet.id);
  const { data: rules, error: rulesError } = await supabase
    .from("lease_expense_rules")
    .select("*")
    .in("rule_set_id", ruleSetIds);

  if (rulesError) {
    if (isMissingExpenseRuleTable(rulesError)) {
      console.warn("[expenseService] lease_expense_rules table missing — treating as no rules.");
      return { ruleSets: latestRuleSets, rules: [], categories: [] };
    }
    throw rulesError;
  }

  const ruleIds = (rules || []).map((rule) => rule.id);
  const categoryIds = [...new Set((rules || []).map((rule) => rule.expense_category_id).filter(Boolean))];

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

  const rulesWithRelations = (rules || []).map((rule) => ({
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

async function upsertExpenseClassification(payload) {
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

    const nextPayload = {
      ...payload,
      expense_id: payload.expense_id || payload.actual_expense_id || null,
      actual_expense_id: payload.actual_expense_id || payload.expense_id || null,
      row_type: rowType,
    };
    const conflictTargets = nextPayload.classification_key
      ? ["classification_key", "org_id,expense_id"]
      : ["org_id,expense_id"];

    for (const onConflict of conflictTargets) {
      const attemptPayload = { ...nextPayload };

      while (Object.keys(attemptPayload).length > 0) {
        const { error } = await supabase
          .from("expense_classifications")
          .upsert(attemptPayload, { onConflict });
        if (!error) return;

        const conflictError = String(error?.message || error?.details || "").toLowerCase();
        if (
          onConflict === "classification_key" &&
          (error?.code === "42P10" || conflictError.includes("no unique") || conflictError.includes("no constraint"))
        ) {
          break;
        }

        const missingColumn = extractMissingColumn(error);
        if (!isMissingColumnError(error) || !missingColumn || !(missingColumn in attemptPayload)) {
          throw error;
        }
        delete attemptPayload[missingColumn];
      }
    }
  } catch (error) {
    console.warn("[expenseService] expense classification persistence warning:", error);
  }
}

async function updateExpenseClassificationRecord(classificationId, patch = {}) {
  if (!supabase || !classificationId) {
    throw new Error("Classification record not found");
  }

  const payload = {
    ...patch,
    updated_at: patch.updated_at || new Date().toISOString(),
  };

  while (Object.keys(payload).length > 0) {
    const { data, error } = await supabase
      .from("expense_classifications")
      .update(payload)
      .eq("id", classificationId)
      .select()
      .single();

    if (!error) {
      return data;
    }

    const missingColumn = extractMissingColumn(error);
    if (!isMissingColumnError(error) || !missingColumn || !(missingColumn in payload)) {
      throw error;
    }
    delete payload[missingColumn];
  }

  return null;
}

async function persistExpenseWorkflowPatch(expenseId, expensePatch = {}) {
  const updatedAt =
    expensePatch.updated_at ||
    expensePatch.classification_updated_at ||
    new Date().toISOString();

  const attempts = [
    expensePatch,
    {
      classification: expensePatch.classification,
      recovery_status: expensePatch.recovery_status,
      approved_status: expensePatch.approved_status,
      review_status: expensePatch.review_status,
      updated_at: updatedAt,
    },
    {
      classification: expensePatch.classification,
      recovery_status: expensePatch.recovery_status,
      updated_at: updatedAt,
    },
    {
      classification: expensePatch.classification,
      updated_at: updatedAt,
    },
  ];

  let lastError = null;
  for (const attempt of attempts) {
    const payload = Object.fromEntries(
      Object.entries(attempt).filter(([, value]) => value !== undefined)
    );
    try {
      return await baseExpenseService.update(expenseId, payload);
    } catch (error) {
      if (!isSchemaCompatibilityError(error)) {
        throw error;
      }
      lastError = error;
    }
  }

  if (lastError) {
    console.warn("[expenseService] unable to persist full expense workflow patch; falling back to classification overlay only:", lastError);
  }

  return {
    id: expenseId,
    ...expensePatch,
    updated_at: updatedAt,
  };
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
      "finalized_at",
      "reviewed_at",
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

  async resolveExpenseLeaseLink(expenseLike = {}, leases = null) {
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

  async update(id, data) {
    const current = await baseExpenseService.get(id);
    const merged = { ...current, ...data, id };
    const { expense } = await this.resolveExpenseLeaseLink(merged);
    const payload = { ...expense };
    delete payload.id;
    return baseExpenseService.update(id, payload);
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
        "finalized_at",
        "reviewed_at",
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
          "finalized_at",
          "reviewed_at",
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
          "finalized_at",
          "reviewed_at",
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

  async updateExpenseClassification(classificationId, patch = {}) {
    return updateExpenseClassificationRecord(classificationId, patch);
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

    const expensePatch = {
      classification,
      recovery_status: effectiveRecoveryStatus,
      recoverability_result: effectiveRecoveryStatus,
      approved_status: effectiveApprovedStatus,
      review_status: effectiveReviewStatus,
      approved_by: effectiveApprovedStatus === "approved" ? userId : null,
      approved_at: effectiveApprovedStatus === "approved" ? now : null,
      rule_source: effectiveRuleSource,
      recovery_reason: plainReason,
      classification_updated_at: now,
      classification_updated_by: userId,
    };

    const updatedExpense = await persistExpenseWorkflowPatch(expense.id, expensePatch);

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
      exception_type: effectiveRecoveryStatus === "needs_review" ? "manual_review" : null,
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
        cam_eligible: "conditional",
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

    let deleted = 0;
    for (const expense of legacyLeaseImportExpenses) {
      const removed = await baseExpenseService.delete(expense.id);
      if (removed) deleted += 1;
    }

    return { created: 0, updated: 0, deleted };
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
        ? (matchedRule.published_to_cam ? match.cam_eligible : "no")
        : "conditional";
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

      const updatePayload = {
        classification: recoveryStatus === "excluded" ? "non_recoverable" : recoveryStatus,
        recovery_status: recoveryStatus,
        recoverability_result: recoveryStatus,
        approved_status: approvedStatus,
        review_status: approvedStatus === "approved" ? "approved" : "needs_review",
        rule_source: ruleSource,
        recovery_reason: plainReason,
        classification_updated_at: new Date().toISOString(),
        lease_id: expense.lease_id || matchedLease?.id || null,
        tenant_id: expense.tenant_id || matchedLease?.tenant_id || null,
        property_id: expense.property_id || matchedLease?.property_id || null,
        building_id: expense.building_id || matchedLease?.building_id || null,
        unit_id: expense.unit_id || matchedLease?.unit_id || null,
      };

      await persistExpenseWorkflowPatch(expense.id, updatePayload);
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
      } else {
        classificationStatus = "matched";
      }
      // Auto-promote to finalized only when the matched rule is itself
      // approved AND the recovery decision is unambiguous. Anything else
      // stays in matched/conditional/exception until a human confirms.
      if (
        (preserveManualReview || matchedRule) &&
        (preserveManualReview || matchedRule.approval_status === "approved") &&
        recoveryStatus === "recoverable" &&
        (preserveManualReview || confidenceScore >= 0.82) &&
        !isConditional
      ) {
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
        cam_eligible: camEligible,
        recovery_method: recoveryMethod,
        recovery_reason: plainReason,
        cam_pool_id: updatePayload.cam_pool_id,
        allocation_method: expense.allocation_method || expense.allocation_type || existingClassification?.allocation_method || "pro_rata",
        allocation_basis: expense.allocation_method || expense.allocation_type || existingClassification?.allocation_basis || existingClassification?.allocation_method || "pro_rata",
        cap_applied: Boolean(matchedRule?.is_subject_to_cap),
        exclusion_applied: Boolean(matchedRule?.is_excluded),
        condition_applied: isConditional,
        condition_reason: isConditional ? matchedRule?.notes || matchedRule?.source || plainReason || "Conditional lease rule requires review" : null,
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
        sent_to_cam: existingClassification?.sent_to_cam || false,
        sent_to_cam_at: existingClassification?.sent_to_cam_at || null,
        sent_to_cam_by: existingClassification?.sent_to_cam_by || null,
        cam_status: existingClassification?.cam_status || null,
        next_step: buildClassificationNextStep({
          classificationStatus,
          recoverabilityResult: recoveryStatus,
          sentToCam: existingClassification?.sent_to_cam || false,
          camEligible,
        }),
        notes: matchedRule?.notes || plainReason || null,
        classified_at: new Date().toISOString(),
      });
    }

    return { updated, needsReview, classified };
  },

  async updateExpenseAmount(expenseId, amount, { reason = "Manual amount correction from Expense Classification" } = {}) {
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount < 0) {
      throw new Error("Enter a valid amount");
    }

    const updatedExpense = await baseExpenseService.update(expenseId, { amount: numericAmount });
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

  async finalizeExpenseClassification(classificationOrExpenseId, recoveryStatus = "recoverable") {
    const authResult = await supabase?.auth?.getUser?.();
    const now = new Date().toISOString();
    const userId = authResult?.data?.user?.id || null;

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

    const updatedExpense = await baseExpenseService.update(expenseId, {
      classification_updated_at: now,
      classification_updated_by: userId,
      review_status: "approved",
      approved_status: "approved",
      recovery_status: recoveryStatus,
      recoverability_result: recoveryStatus,
      classification: recoveryStatus,
    });

    if (classification?.id) {
      const amount = toNumber(classification.amount ?? expense?.amount ?? updatedExpense?.amount);
      const amountBuckets = buildAmountBuckets(amount, recoveryStatus);
      await updateExpenseClassificationRecord(classification.id, {
        recoverability_result: recoveryStatus,
        recovery_status: recoveryStatus,
        approved_status: "approved",
        classification_status: "finalized",
        exception_type: null,
        reviewed_at: now,
        reviewed_by: userId,
        approved_at: now,
        approved_by: userId,
        finalized_at: now,
        ...amountBuckets,
        next_step:
          normalizeText(classification.cam_eligible) === "yes" && recoveryStatus === "recoverable"
            ? "Send to CAM"
            : "Ready for projection",
      });
    }

    return updatedExpense;
  },

  async reopenExpenseClassification(classificationOrExpenseId) {
    const now = new Date().toISOString();
    const classification =
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

    const updatedExpense = await baseExpenseService.update(expenseId, {
      classification_status: "matched",
      finalized_at: null,
      reviewed_at: now,
      cam_status: null,
      next_step: "Finalize row",
    });

    if (classification?.id) {
      await updateExpenseClassificationRecord(classification.id, {
        classification_status: "matched",
        finalized_at: null,
        cam_status: null,
        next_step: "Finalize row",
      });
    }

    return updatedExpense;
  },

  async sendExpenseClassificationToReview(classificationOrExpenseId) {
    const authResult = await supabase?.auth?.getUser?.();
    const now = new Date().toISOString();
    const userId = authResult?.data?.user?.id || null;
    const classification =
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

    const updatedExpense = await baseExpenseService.update(expenseId, {
      classification_status: "exception",
      exception_type: "manual_review",
      reviewed_at: now,
      reviewed_by: userId,
      next_step: "Resolve exception",
    });

    if (classification?.id) {
      await updateExpenseClassificationRecord(classification.id, {
        classification_status: "exception",
        exception_type: "manual_review",
        reviewed_at: now,
        reviewed_by: userId,
        next_step: "Resolve exception",
      });
    }

    return updatedExpense;
  },

  async sendClassificationToCam(classificationOrId) {
    const classification =
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
            ],
            apply: (query) => query.eq("id", classificationOrId).limit(1),
          }).then((rows) => rows[0] || null);

    if (!classification?.id) {
      throw new Error("Classification row not found");
    }

    const expenseId = classification.expense_id || classification.actual_expense_id;
    const ruleId =
      classification.lease_expense_rule_id ||
      classification.linked_expense_rule_id ||
      null;
    const [expense, authResult, ruleResult] = await Promise.all([
      expenseId ? baseExpenseService.get(expenseId) : Promise.resolve(null),
      supabase?.auth?.getUser?.() || Promise.resolve(null),
      ruleId
        ? supabase.from("lease_expense_rules").select("*").eq("id", ruleId).single()
        : Promise.resolve({ data: null, error: null }),
    ]);

    if (ruleResult?.error) {
      throw ruleResult.error;
    }

    const rule = ruleResult?.data || null;
    if (!canSendClassificationToCam({ classification, expense, rule })) {
      throw new Error("Only finalized, CAM-eligible, approved recoverable rows can be sent to CAM.");
    }

    const now = new Date().toISOString();
    const userId = authResult?.data?.user?.id || null;
    const inputPayload = {
      org_id: classification.org_id || expense?.org_id || null,
      property_id: classification.property_id || expense?.property_id || null,
      building_id: classification.building_id || expense?.building_id || null,
      unit_id: classification.unit_id || expense?.unit_id || null,
      lease_id: classification.lease_id || expense?.lease_id || null,
      tenant_id: classification.tenant_id || expense?.tenant_id || null,
      actual_expense_id: expenseId,
      classification_result_id: classification.id,
      lease_expense_rule_id: ruleId,
      category: classification.category || expense?.category || null,
      amount: toNumber(classification.amount ?? expense?.amount),
      recovery_method: classification.recovery_method || null,
      allocation_basis: classification.allocation_basis || null,
      source: "expense_classification",
      status: "pending_cam_review",
      sent_to_cam_at: now,
      sent_to_cam_by: userId,
      updated_at: now,
    };

    const { error } = await supabase
      .from("cam_expense_inputs")
      .upsert(inputPayload, { onConflict: "classification_result_id" });

    if (error) {
      throw error;
    }

    return updateExpenseClassificationRecord(classification.id, {
      sent_to_cam: true,
      sent_to_cam_at: now,
      sent_to_cam_by: userId,
      cam_status: "pending_cam_review",
      next_step: "Sent to CAM",
    });
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
    const approvedRuleLeaseIds = new Set((rules || []).filter((rule) => approvedRuleForMatching(rule)).map((rule) => rule.lease_id).filter(Boolean));

    const actualExpenses = scopedExpenses.filter((expense) => normalizeSourceType(expense) !== "lease_import");
    const needsReviewExpenses = actualExpenses.filter((expense) => normalizeText(expense.approved_status) === "needs_review" || normalizeText(expense.recovery_status) === "needs_review");
    const missingCategoryExpenses = actualExpenses.filter((expense) => !expense.category && !expense.expense_subcategory);
    const conditionalExpenses = actualExpenses.filter((expense) => normalizeText(expense.recovery_status) === "conditional");
    const missingSqftLeases = scopedLeases.filter((lease) => !toNumber(lease.square_footage));
    const missingDatesLeases = scopedLeases.filter((lease) => !lease.start_date || !lease.end_date);

    return {
      scopedLeaseCount: scopedLeases.length,
      approvedLeaseCount: scopedLeases.filter((lease) => ["approved", "budget_ready", "active", "executed"].includes(normalizeLeaseStatus(lease.status))).length,
      approvedRuleLeaseCount: approvedRuleLeaseIds.size,
      expenseCount: actualExpenses.length,
      actualExpenseCount: actualExpenses.length,
      needsReviewCount: needsReviewExpenses.length,
      conditionalExpenseCount: conditionalExpenses.length,
      missingCategoryCount: missingCategoryExpenses.length,
      missingSquareFootageCount: missingSqftLeases.length,
      missingLeaseDatesCount: missingDatesLeases.length,
      canRunCam:
        scopedLeases.length > 0 &&
        approvedRuleLeaseIds.size > 0 &&
        actualExpenses.length > 0 &&
        needsReviewExpenses.length === 0 &&
        missingSqftLeases.length === 0 &&
        missingDatesLeases.length === 0,
    };
  },

  async loadApprovedLeaseExpenseRules(scope = {}) {
    const orgLeases = await listWorkflowEntityRows("Lease");
    const scopedLeases = (orgLeases || []).filter((lease) => leaseMatchesScope(lease, scope));
    const leaseIds = [...new Set(scopedLeases.map((lease) => lease.id).filter(Boolean))];
    if (leaseIds.length === 0) return [];

    const leaseById = new Map((orgLeases || []).map((lease) => [lease.id, lease]));
    const ruleEntries = await leaseExpenseRuleService.loadRuleSets(leaseIds);
    const normalizedRules = (ruleEntries || [])
      .flatMap((entry) =>
        (entry.rules || []).map((rule) => ({
          ...rule,
          lease_id: rule.lease_id || entry.leaseId,
          rule_set: entry.ruleSet || null,
        }))
      );

    let directRules = [];
    try {
      const { ruleSets, rules } = await fetchApprovedRuleArtifacts(leaseIds);
      const ruleSetById = new Map((ruleSets || []).map((ruleSet) => [ruleSet.id, ruleSet]));
      directRules = (rules || []).map((rule) => ({
        ...rule,
        lease_id: rule.lease_id || ruleSetById.get(rule.rule_set_id)?.lease_id || null,
        rule_set: ruleSetById.get(rule.rule_set_id) || null,
      }));
    } catch (error) {
      console.warn("[expenseService] direct approved rule fallback warning:", error);
    }

    const mergedRules = mergeLeaseRuleSources(directRules, normalizedRules);

    return mergedRules.filter((rule) =>
      isApprovedLeaseRule(rule) &&
      ruleMatchesScope(rule, leaseById.get(rule.lease_id || rule.rule_set?.lease_id) || null, scope)
    );
  },

  async loadApprovedActualExpenses(scope = {}) {
    const [allExpenses, allLeases] = await Promise.all([
      listWorkflowEntityRows("Expense"),
      listWorkflowEntityRows("Lease"),
    ]);
    const actualExpenses = (allExpenses || []).filter((expense) =>
      normalizeSourceType(expense) !== "lease_import" &&
      expenseMatchesScope(expense, scope)
    );
    const expenseIds = actualExpenses.map((expense) => expense.id).filter(Boolean);
    const existingClassifications = expenseIds.length > 0
      ? await fetchExistingExpenseClassifications(expenseIds)
      : [];
    const classificationByExpenseId = new Map();
    for (const classification of existingClassifications) {
      const expenseId = classification.expense_id || classification.actual_expense_id;
      if (!expenseId || classificationByExpenseId.has(expenseId)) continue;
      classificationByExpenseId.set(expenseId, classification);
    }

    const approvedExpenses = [];
    for (const expense of actualExpenses) {
      const classification = classificationByExpenseId.get(expense.id) || null;
      if (!isApprovedExpenseRecord(expense, classification)) continue;
      const { expense: linkedExpense } = await this.resolveExpenseLeaseLink({
        ...expense,
        approved_status: classification?.approved_status || expense.approved_status || expense.approval_status,
        recovery_status: classification?.recoverability_result || classification?.recovery_status || expense.recovery_status,
        recoverability_result: classification?.recoverability_result || classification?.recovery_status || expense.recoverability_result,
        classification: classification?.recoverability_result || classification?.recovery_status || expense.classification,
        recovery_reason: classification?.recovery_reason || expense.recovery_reason,
        rule_source: classification?.rule_source || expense.rule_source,
        cam_eligible: classification?.cam_eligible || expense.cam_eligible,
        recovery_method: classification?.recovery_method || expense.recovery_method,
      }, allLeases);
      approvedExpenses.push(linkedExpense);
    }

    return approvedExpenses;
  },

  async loadExpenseRecoverabilityScope(scope = {}) {
    const [approvedRules, approvedActuals] = await Promise.all([
      this.loadApprovedLeaseExpenseRules(scope),
      this.loadApprovedActualExpenses(scope)
    ]);

    const expenseIds = approvedActuals.map(e => e.id);
    const existingClassifications = expenseIds.length > 0
      ? await fetchExistingExpenseClassifications(expenseIds)
      : [];

    return {
      approvedRules,
      approvedActuals,
      existingClassifications,
      summary: {
        rulesCount: approvedRules.length,
        actualsCount: approvedActuals.length,
        classificationsCount: existingClassifications.length
      }
    };
  },

  async loadExpenseRecoverabilityDiagnostics(scope = {}) {
    const orgId = await getCurrentOrgId();
    const actingOrgId = getStoredActingOrgId();
    const authResult = await supabase?.auth?.getUser?.();
    const { me } = await import("@/services/auth");
    const currentUser = await me().catch(() => null);

    const [allLeases, allExpenses] = await Promise.all([
      listWorkflowEntityRows("Lease"),
      listWorkflowEntityRows("Expense"),
    ]);

    const leaseIds = [...new Set((allLeases || []).map((lease) => lease.id).filter(Boolean))];
    const ruleEntries = await leaseExpenseRuleService.loadRuleSets(leaseIds);
    const leaseById = new Map((allLeases || []).map((lease) => [lease.id, lease]));
    const normalizedRules = (ruleEntries || []).flatMap((entry) =>
      (entry.rules || []).map((rule) => ({
        ...rule,
        lease_id: rule.lease_id || entry.leaseId,
        rule_set: entry.ruleSet || null,
      }))
    );

    let directRules = [];
    try {
      const { ruleSets, rules } = await fetchApprovedRuleArtifacts(leaseIds);
      const ruleSetById = new Map((ruleSets || []).map((ruleSet) => [ruleSet.id, ruleSet]));
      directRules = (rules || []).map((rule) => ({
        ...rule,
        lease_id: rule.lease_id || ruleSetById.get(rule.rule_set_id)?.lease_id || null,
        rule_set: ruleSetById.get(rule.rule_set_id) || null,
      }));
    } catch (error) {
      console.warn("[expenseService] diagnostics direct rule fallback warning:", error);
    }

    const rawRules = mergeLeaseRuleSources(directRules, normalizedRules);

    const approvedRulesOrg = rawRules.filter((rule) => isApprovedLeaseRule(rule));
    const needsReviewRulesOrg = rawRules.filter((rule) => approvedRuleState(rule) === "needs_review");
    const rejectedOrNaRulesOrg = rawRules.filter((rule) => ["rejected", "na"].includes(approvedRuleState(rule)));

    const approvedActualsOrg = (allExpenses || []).filter((expense) =>
      normalizeSourceType(expense) !== "lease_import" && isApprovedExpenseRecord(expense)
    );
    const pendingActualsOrg = (allExpenses || []).filter((expense) =>
      normalizeSourceType(expense) !== "lease_import" && isPendingExpenseRecord(expense)
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

    const rulesMatchingProperty = approvedRulesOrg.filter((rule) => ruleMatchesScope(rule, leaseById.get(rule.lease_id || rule.rule_set?.lease_id) || null, { ...scope, building_id: "all", unit_id: "all", lease_id: "all", tenant_id: "all", fiscal_year: "all" }));
    const rulesMatchingBuilding = approvedRulesOrg.filter((rule) => ruleMatchesScope(rule, leaseById.get(rule.lease_id || rule.rule_set?.lease_id) || null, { ...scope, unit_id: "all", lease_id: "all", tenant_id: "all", fiscal_year: "all" }));
    const rulesMatchingUnit = approvedRulesOrg.filter((rule) => ruleMatchesScope(rule, leaseById.get(rule.lease_id || rule.rule_set?.lease_id) || null, { ...scope, lease_id: "all", tenant_id: "all", fiscal_year: "all" }));
    const rulesMatchingLease = approvedRulesOrg.filter((rule) => ruleMatchesScope(rule, leaseById.get(rule.lease_id || rule.rule_set?.lease_id) || null, { ...scope, tenant_id: "all", fiscal_year: "all" }));

    const actualsMatchingProperty = approvedActualsOrg.filter((expense) => expenseMatchesScope(expense, { ...scope, building_id: "all", unit_id: "all", lease_id: "all", tenant_id: "all", fiscal_year: "all" }));
    const actualsMatchingBuilding = approvedActualsOrg.filter((expense) => expenseMatchesScope(expense, { ...scope, unit_id: "all", lease_id: "all", tenant_id: "all", fiscal_year: "all" }));
    const actualsMatchingUnit = approvedActualsOrg.filter((expense) => expenseMatchesScope(expense, { ...scope, lease_id: "all", tenant_id: "all", fiscal_year: "all" }));
    const actualsMatchingLease = approvedActualsOrg.filter((expense) => expenseMatchesScope(expense, { ...scope, tenant_id: "all", fiscal_year: "all" }));
    const scopedApprovedRules = approvedRulesOrg.filter((rule) =>
      ruleMatchesScope(rule, leaseById.get(rule.lease_id || rule.rule_set?.lease_id) || null, scope)
    );
    const scopedApprovedActuals = approvedActualsOrg.filter((expense) => expenseMatchesScope(expense, scope));

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
      selected_scope: scope,
      raw_expenses_count_for_org: (allExpenses || []).length,
      approved_expenses_count_before_scope: approvedActualsOrg.length,
      approved_expenses_count_after_scope: scopedApprovedActuals.length,
      first_10_approved_expenses: first10ApprovedExpenses,
      raw_lease_expense_rules_count_for_org: rawRules.length,
      approved_lease_rules_count_before_scope: approvedRulesOrg.length,
      approved_lease_rules_count_after_scope: scopedApprovedRules.length,
      first_10_approved_rules: first10ApprovedRules,
      expense_classifications_count_for_org: allClassifications.length,
      finalized_classifications_count: allClassifications.filter(c => c.classification_status === "finalized").length,
      excluded_expenses_with_reason: approvedActualsOrg.filter(e => !expenseMatchesScope(e, scope)).map(e => ({ id: e.id, reason: "out of scope" })),
      excluded_rules_with_reason: approvedRulesOrg.filter(r => !ruleMatchesScope(r, leaseById.get(r.lease_id || r.rule_set?.lease_id) || null, scope)).map(r => ({ id: r.id, reason: "out of scope" }))
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
      leases: leases
    });
  },
};

export default expenseService;
