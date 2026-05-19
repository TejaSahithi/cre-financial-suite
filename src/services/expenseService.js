import { createEntityService, getCurrentOrgId } from "@/services/api";
import { supabase } from "@/services/supabaseClient";
import { leaseExpenseRuleService } from "@/services/leaseExpenseRuleService";

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
  const reviewStatus = normalizeText(rule?.review_status) === "reviewed" ? "approved" : normalizeText(rule?.review_status);
  return normalizeText(rule?.approval_status) === "approved" && reviewStatus === "approved";
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

async function fetchApprovedRuleArtifacts(leaseIds = []) {
  if (!supabase || leaseIds.length === 0) {
    return { ruleSets: [], rules: [], categories: [] };
  }

  const { data: ruleSets, error: ruleSetError } = await supabase
    .from("lease_expense_rule_sets")
    .select("id, lease_id, status")
    .in("lease_id", leaseIds)
    .eq("status", "approved");

  if (ruleSetError) {
    if (isMissingExpenseRuleTable(ruleSetError)) {
      console.warn("[expenseService] lease_expense_rule_sets table missing — treating as no rules.");
      return { ruleSets: [], rules: [], categories: [] };
    }
    throw ruleSetError;
  }
  if (!ruleSets?.length) return { ruleSets: [], rules: [], categories: [] };

  const ruleSetIds = ruleSets.map((ruleSet) => ruleSet.id);
  const { data: rules, error: rulesError } = await supabase
    .from("lease_expense_rules")
    .select("*")
    .in("rule_set_id", ruleSetIds);

  if (rulesError) {
    if (isMissingExpenseRuleTable(rulesError)) {
      console.warn("[expenseService] lease_expense_rules table missing — treating as no rules.");
      return { ruleSets, rules: [], categories: [] };
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
    lease_id: ruleSets.find((ruleSet) => ruleSet.id === rule.rule_set_id)?.lease_id || null,
    ...valuesByRuleId.get(rule.id),
    clauses: clausesByRuleId.get(rule.id) || [],
  }));

  return {
    ruleSets: ruleSets || [],
    rules: rulesWithRelations,
    categories: safeCategories,
  };
}

async function upsertExpenseClassification(payload) {
  if (!supabase || !payload?.expense_id || !payload?.org_id) return;
  try {
    const nextPayload = { ...payload };

    while (Object.keys(nextPayload).length > 0) {
      const { error } = await supabase
        .from("expense_classifications")
        .upsert(nextPayload, { onConflict: "org_id,expense_id" });
      if (!error) return;

      const missingColumn = extractMissingColumn(error);
      if (!isMissingColumnError(error) || !missingColumn || !(missingColumn in nextPayload)) {
        throw error;
      }
      delete nextPayload[missingColumn];
    }
  } catch (error) {
    console.warn("[expenseService] expense classification persistence warning:", error);
  }
}

async function fetchExistingExpenseClassifications(expenseIds = []) {
  if (!supabase || expenseIds.length === 0) return [];
  try {
    return await selectExpenseClassifications({
      columns: [
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
        "linked_expense_rule_id",
        "recovery_status",
        "recoverability_result",
        "cam_pool_id",
        "recovery_reason",
        "cam_eligible",
        "recovery_method",
        "allocation_method",
        "rule_source",
        "confidence_score",
        "evidence_text",
        "evidence_page_number",
        "approved_status",
        "notes",
        "classified_by",
        "classified_at",
        "approved_by",
        "approved_at",
        "reviewed_at",
        "finalized_at",
        "classification_status",
        "exception_type",
        "amount",
      ],
      apply: (query) => query.in("expense_id", expenseIds),
    });
  } catch (error) {
    if (isMissingExpenseRuleTable(error)) {
      console.warn("[expenseService] expense_classifications table missing — treating as no persisted classifications.");
      return [];
    }
    console.warn("[expenseService] failed to load persisted classifications:", error);
    return [];
  }
}

export const expenseService = {
  ...baseExpenseService,

  async listExpenseClassificationsForExpenses(expenseIds = []) {
    if (!expenseIds.length) return [];
    try {
      return await selectExpenseClassifications({
        columns: [
          "expense_id",
          "recovery_status",
          "recoverability_result",
          "approved_status",
          "rule_source",
          "classification_status",
          "confidence_score",
          "recovery_reason",
          "cam_eligible",
          "recovery_method",
          "approved_at",
          "reviewed_at",
          "finalized_at",
        ],
        apply: (query) => query.in("expense_id", expenseIds),
      });
    } catch (error) {
      console.warn("[expenseService] listExpenseClassificationsForExpenses warning:", error);
      return [];
    }
  },

  async listExpenseClassificationsForLease({ leaseId, propertyId = null, limit = 1000 } = {}) {
    if (!leaseId) return [];
    try {
      return await selectExpenseClassifications({
        columns: [
          "id",
          "expense_id",
          "lease_expense_rule_id",
          "recovery_rule_id",
          "recoverability_result",
          "recovery_status",
          "cam_eligible",
          "recovery_method",
          "recovery_reason",
          "classification_status",
          "exception_type",
          "confidence_score",
          "finalized_at",
          "reviewed_at",
          "amount",
          "classified_at",
          "lease_id",
          "property_id",
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
      console.warn("[expenseService] listExpenseClassificationsForLease warning:", error);
      return [];
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
    const classification =
      effectiveRecoveryStatus === "excluded" ? "non_recoverable" : effectiveRecoveryStatus;

    const expensePatch = {
      classification,
    };

    const updatedExpense = await baseExpenseService.update(expense.id, expensePatch);

    await upsertExpenseClassification({
      id: existingClassification?.id,
      org_id: expense.org_id || existingClassification?.org_id || orgIdFallback,
      expense_id: expense.id,
      actual_expense_id: expense.id,
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
        existingClassification?.linked_expense_rule_id ||
        expense.linked_expense_rule_id ||
        expense.recovery_rule_id ||
        null,
      category: expense.category || null,
      subcategory: expense.expense_subcategory || expense.subcategory || null,
      amount: Number.isFinite(Number(expense.amount)) ? Number(expense.amount) : existingClassification?.amount ?? null,
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
      recovery_reason: effectiveReason,
      cam_pool_id: existingClassification?.cam_pool_id || expense.cam_pool_id || null,
      allocation_method:
        expense.allocation_method ||
        expense.allocation_type ||
        existingClassification?.allocation_method ||
        "pro_rata",
      cap_applied: Boolean(existingClassification?.cap_applied),
      exclusion_applied: ["excluded", "non_recoverable"].includes(effectiveRecoveryStatus),
      condition_applied: effectiveRecoveryStatus === "conditional",
      condition_reason: effectiveRecoveryStatus === "conditional" ? effectiveReason : null,
      rule_source: effectiveRuleSource,
      confidence_score: existingClassification?.confidence_score ?? expense.confidence_score ?? 1,
      evidence_text: existingClassification?.evidence_text || expense.evidence_text || effectiveReason,
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
        effectiveApprovedStatus === "approved" && effectiveRecoveryStatus === "recoverable"
          ? (existingClassification?.finalized_at || now)
          : null,
      reviewed_at: now,
      approved_at: effectiveApprovedStatus === "approved" ? (existingClassification?.approved_at || now) : null,
      approved_by: effectiveApprovedStatus === "approved" ? (userId || existingClassification?.approved_by || null) : null,
      classified_at: existingClassification?.classified_at || now,
      classified_by: userId || existingClassification?.classified_by || null,
      notes: effectiveReason || existingClassification?.notes || null,
    });

    return {
      ...updatedExpense,
      recovery_status: effectiveRecoveryStatus,
      recoverability_result: effectiveRecoveryStatus,
      approved_status: effectiveApprovedStatus,
      rule_source: effectiveRuleSource,
      recovery_reason: effectiveReason,
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

    if (!actualExpenses.length) {
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
      (await fetchExistingExpenseClassifications(actualExpenses.map((expense) => expense.id)))
        .map((classification) => [classification.expense_id, classification])
    );

    let updated = 0;
    let needsReview = 0;
    let classified = 0;

    for (const expense of actualExpenses) {
      const existingClassification = existingClassificationsByExpenseId.get(expense.id) || null;
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
      }

      const updatePayload = {
        classification: recoveryStatus === "excluded" ? "non_recoverable" : recoveryStatus,
      };

      await baseExpenseService.update(expense.id, updatePayload);
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
        amount: Number.isFinite(Number(expense.amount)) ? Number(expense.amount) : null,
        service_period_start: expense.service_period_start || expense.date || null,
        service_period_end: expense.service_period_end || expense.date || null,
        recovery_status: recoveryStatus,
        recoverability_result: recoveryStatus,
        cam_eligible: camEligible,
        recovery_method: recoveryMethod,
        recovery_reason: recoveryReason,
        cam_pool_id: updatePayload.cam_pool_id,
        allocation_method: updatePayload.allocation_method,
        cap_applied: Boolean(matchedRule?.is_subject_to_cap),
        exclusion_applied: Boolean(matchedRule?.is_excluded),
        condition_applied: isConditional,
        condition_reason: isConditional ? matchedRule?.notes || matchedRule?.source || recoveryReason || "Conditional lease rule requires review" : null,
        rule_source: updatePayload.rule_source,
        confidence_score: confidenceScore,
        evidence_text: matchedRule?.source || recoveryReason,
        evidence_page_number: matchedRule?.clauses?.[0]?.page_number ?? null,
        approved_status: approvedStatus,
        classification_status: classificationStatus,
        exception_type: exceptionType,
        finalized_at: classificationStatus === "finalized" ? new Date().toISOString() : null,
        notes: matchedRule?.notes || recoveryReason || null,
        classified_at: new Date().toISOString(),
      });
    }

    return { updated, needsReview, classified };
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
    const { ruleSets } = await fetchApprovedRuleArtifacts(leaseIds);
    const approvedRuleLeaseIds = new Set((ruleSets || []).map((ruleSet) => ruleSet.lease_id));

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
};

export default expenseService;
