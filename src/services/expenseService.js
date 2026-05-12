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

function buildCoreLeaseDerivedPayloads(lease, propertyById) {
  const status = normalizeLeaseStatus(lease?.status);
  if (!SYNCABLE_LEASE_STATUSES.has(status)) return [];
  if (!lease?.id || !lease?.property_id) return [];

  const fiscalYear = deriveLeaseExpenseFiscalYear(lease);
  const expenseDate = deriveLeaseExpenseDate(lease, fiscalYear);
  const month = Number(expenseDate.slice(5, 7)) || 1;
  const tenantName = String(lease.tenant_name || "Lease");
  const property = propertyById.get(lease.property_id) || null;

  return LEASE_DERIVED_EXPENSES.flatMap((definition) => {
    const amount = toNumber(lease?.[definition.field]);
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

function conditionApplied(rule) {
  const source = normalizeText(rule?.source);
  const notes = normalizeText(rule?.notes);
  return CONDITIONAL_KEYWORDS.some((keyword) => source.includes(keyword) || notes.includes(keyword));
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

  if (ruleSetError) throw ruleSetError;
  if (!ruleSets?.length) return { ruleSets: [], rules: [], categories: [] };

  const ruleSetIds = ruleSets.map((ruleSet) => ruleSet.id);
  const { data: rules, error: rulesError } = await supabase
    .from("lease_expense_rules")
    .select("*")
    .in("rule_set_id", ruleSetIds);

  if (rulesError) throw rulesError;

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

  if (valuesError) throw valuesError;
  if (clausesError) throw clausesError;
  if (categoriesError) throw categoriesError;

  const valuesByRuleId = new Map((values || []).map((value) => [value.rule_id, value]));
  const clausesByRuleId = new Map();
  (clauses || []).forEach((clause) => {
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
    categories: categories || [],
  };
}

async function upsertExpenseClassification(payload) {
  if (!supabase || !payload?.expense_id || !payload?.org_id) return;
  try {
    const { error } = await supabase
      .from("expense_classifications")
      .upsert(payload, { onConflict: "org_id,expense_id" });
    if (error) throw error;
  } catch (error) {
    console.warn("[expenseService] expense classification persistence warning:", error);
  }
}

export const expenseService = {
  ...baseExpenseService,

  async syncLeaseDerivedExpenses({ leases = [], existingExpenses = [], properties = [] } = {}) {
    const propertyById = buildPropertyLookup(properties);
    const leaseIds = new Set((leases || []).map((lease) => lease?.id).filter(Boolean));
    const relevantLeases = (leases || []).filter((lease) => lease?.id);
    const { rules, categories } = await fetchApprovedRuleArtifacts([...leaseIds]);
    const { rulesByLeaseId } = buildApprovedRuleLookups(rules, categories);

    const targetPayloads = relevantLeases.flatMap((lease) => {
      const corePayloads = buildCoreLeaseDerivedPayloads(lease, propertyById);
      const rulePayloads = buildRuleDerivedPayloads(lease, rulesByLeaseId.get(lease.id) || [], propertyById);
      return [...corePayloads, ...rulePayloads];
    });

    const relevantCategories = new Set(targetPayloads.map((payload) => payload.category));
    const allExistingExpenses =
      Array.isArray(existingExpenses) && existingExpenses.length > 0
        ? existingExpenses
        : await baseExpenseService.list();

    const relevantExistingExpenses = (allExistingExpenses || []).filter((expense) =>
      normalizeSourceType(expense) === "lease_import" &&
      leaseIds.has(expense.lease_id) &&
      relevantCategories.has(expense.category)
    );

    const targetByKey = new Map(targetPayloads.map((payload) => [expenseSyncKey(payload), payload]));
    const existingByKey = new Map();
    const duplicateExistingExpenses = [];

    for (const expense of relevantExistingExpenses) {
      const key = expenseSyncKey({
        lease_id: expense.lease_id,
        category: expense.category,
        fiscal_year: expense.fiscal_year,
        source_type: normalizeSourceType(expense),
      });

      if (existingByKey.has(key)) {
        duplicateExistingExpenses.push(expense);
        continue;
      }
      existingByKey.set(key, expense);
    }

    const summary = { created: 0, updated: 0, deleted: 0 };

    for (const duplicateExpense of duplicateExistingExpenses) {
      const removed = await baseExpenseService.delete(duplicateExpense.id);
      if (removed) summary.deleted += 1;
    }

    for (const existingExpense of existingByKey.values()) {
      const key = expenseSyncKey({
        lease_id: existingExpense.lease_id,
        category: existingExpense.category,
        fiscal_year: existingExpense.fiscal_year,
        source_type: normalizeSourceType(existingExpense),
      });

      if (!targetByKey.has(key)) {
        const removed = await baseExpenseService.delete(existingExpense.id);
        if (removed) summary.deleted += 1;
      }
    }

    for (const payload of targetPayloads) {
      const key = expenseSyncKey(payload);
      const existingExpense = existingByKey.get(key);

      if (!existingExpense) {
        await baseExpenseService.create(payload);
        summary.created += 1;
        continue;
      }

      if (shouldUpdateExpense(existingExpense, payload)) {
        await baseExpenseService.update(existingExpense.id, payload);
        summary.updated += 1;
      }
    }

    return summary;
  },

  async classifyExpenses({ expenses = [], leases = [] } = {}) {
    const allExpenses =
      Array.isArray(expenses) && expenses.length > 0
        ? expenses
        : await baseExpenseService.list();

    if (!allExpenses.length) {
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

    let updated = 0;
    let needsReview = 0;
    let classified = 0;

    for (const expense of allExpenses) {
      const expenseLeaseId = expense.lease_id || null;
      const candidateLeases = expenseLeaseId
        ? [leaseById.get(expenseLeaseId)].filter(Boolean)
        : allLeases.filter((lease) => {
            if (expense.property_id && lease.property_id !== expense.property_id) return false;
            if (expense.unit_id && lease.unit_id && lease.unit_id !== expense.unit_id) return false;
            if (expense.building_id && lease.building_id && lease.building_id !== expense.building_id) return false;
            return SYNCABLE_LEASE_STATUSES.has(normalizeLeaseStatus(lease.status));
          });

      let matchedRule = null;
      let matchedLease = null;
      let matchedRuleSet = null;
      let bestScore = 0;

      for (const lease of candidateLeases) {
        const candidateRules = rulesByLeaseId.get(lease.id) || [];
        for (const rule of candidateRules) {
          const score = scoreRuleMatch(expense, rule);
          if (score > bestScore) {
            bestScore = score;
            matchedRule = rule;
            matchedLease = lease;
            matchedRuleSet = ruleSets.find((ruleSet) => ruleSet.id === rule.rule_set_id) || null;
          }
        }
      }

      const recoveryStatus = matchedRule ? normalizeRecoveryStatus(matchedRule) : "needs_review";
      const isConditional = matchedRule ? recoveryStatus === "conditional" || conditionApplied(matchedRule) : false;
      const confidenceScore = matchedRule
        ? asNumberOrNull(matchedRule.confidence) ?? Math.min(bestScore / 100, 1)
        : 0;
      const approvedStatus =
        matchedRule && !isConditional && confidenceScore >= 0.75
          ? "classified"
          : "needs_review";

      const updatePayload = {
        lease_id: expense.lease_id || matchedLease?.id || null,
        tenant_id: expense.tenant_id || matchedLease?.tenant_id || null,
        tenant_name: expense.tenant_name || matchedLease?.tenant_name || null,
        classification: recoveryStatus === "excluded" ? "non_recoverable" : recoveryStatus,
        recovery_status: recoveryStatus,
        allocation_method: expense.allocation_method || expense.allocation_type || matchedLease?.allocation_method || "pro_rata",
        allocation_type: expense.allocation_type || expense.allocation_method || matchedLease?.allocation_method || "pro_rata",
        recovery_rule_id: matchedRule?.id || null,
        rule_source: matchedRule ? "lease" : (expense.rule_source || "default"),
        confidence_score: confidenceScore,
        evidence_text: matchedRule?.source || null,
        evidence_page_number: matchedRule?.clauses?.[0]?.page_number ?? null,
        approved_status: approvedStatus,
        classification_updated_at: new Date().toISOString(),
      };

      await baseExpenseService.update(expense.id, updatePayload);
      updated += 1;

      if (approvedStatus === "needs_review") {
        needsReview += 1;
      } else {
        classified += 1;
      }

      await upsertExpenseClassification({
        org_id: expense.org_id || matchedLease?.org_id || orgIdFallback,
        expense_id: expense.id,
        property_id: expense.property_id || matchedLease?.property_id || null,
        building_id: expense.building_id || matchedLease?.building_id || null,
        unit_id: expense.unit_id || matchedLease?.unit_id || null,
        lease_id: expense.lease_id || matchedLease?.id || null,
        tenant_id: expense.tenant_id || matchedLease?.tenant_id || null,
        rule_set_id: matchedRuleSet?.id || null,
        recovery_rule_id: matchedRule?.id || null,
        recovery_status: recoveryStatus,
        allocation_method: updatePayload.allocation_method,
        cap_applied: Boolean(matchedRule?.is_subject_to_cap),
        exclusion_applied: Boolean(matchedRule?.is_excluded),
        condition_applied: isConditional,
        condition_reason: isConditional ? matchedRule?.notes || matchedRule?.source || "Conditional lease rule requires review" : null,
        rule_source: updatePayload.rule_source,
        confidence_score: confidenceScore,
        evidence_text: matchedRule?.source || null,
        evidence_page_number: matchedRule?.clauses?.[0]?.page_number ?? null,
        approved_status: approvedStatus,
        notes: matchedRule?.notes || null,
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
    const needsReviewExpenses = scopedExpenses.filter((expense) => normalizeText(expense.approved_status) === "needs_review" || normalizeText(expense.recovery_status) === "needs_review");
    const missingCategoryExpenses = scopedExpenses.filter((expense) => !expense.category && !expense.expense_subcategory);
    const conditionalExpenses = scopedExpenses.filter((expense) => normalizeText(expense.recovery_status) === "conditional");
    const missingSqftLeases = scopedLeases.filter((lease) => !toNumber(lease.square_footage));
    const missingDatesLeases = scopedLeases.filter((lease) => !lease.start_date || !lease.end_date);

    return {
      scopedLeaseCount: scopedLeases.length,
      approvedLeaseCount: scopedLeases.filter((lease) => ["approved", "budget_ready", "active", "executed"].includes(normalizeLeaseStatus(lease.status))).length,
      approvedRuleLeaseCount: approvedRuleLeaseIds.size,
      expenseCount: scopedExpenses.length,
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
